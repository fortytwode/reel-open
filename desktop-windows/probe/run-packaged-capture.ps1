[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$QaRoot,
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$ExpectedArchitecture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Run packaged capture QA on Windows.' }
$sessionId = (Get-Process -Id $PID).SessionId
if ($sessionId -eq 0) { throw 'The hosted runner is in Session 0; capture needs a normal runner desktop session.' }

$appRoot = Join-Path $PackageRoot 'resources/app'
$packageJsonPath = Join-Path $appRoot 'package.json'
$exe = Join-Path $PackageRoot 'Reel.exe'
$buildInfoPath = Join-Path $PackageRoot 'build-info.json'
foreach ($path in @($packageJsonPath, $exe, $buildInfoPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Extracted package is missing $path" }
}
$buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
$buildArchitecture = $buildInfo.PSObject.Properties['architecture'].Value
$buildElectron = $buildInfo.PSObject.Properties['electron'].Value
if ($buildArchitecture -ne $ExpectedArchitecture -or $buildElectron -ne '45.2.3') {
  throw "Extracted runtime mismatch: expected Electron 45.2.3 $ExpectedArchitecture."
}
$workerRelative = 'web/reel/encoder-worker.js'
$workerProperty = $buildInfo.sourceSha256.PSObject.Properties[$workerRelative]
$sourceWorkerHash = (Get-FileHash -LiteralPath (Join-Path $SourceRoot 'web/reel/encoder-worker.js') -Algorithm SHA256).Hash.ToLowerInvariant()
$packagedWorkerHash = (Get-FileHash -LiteralPath (Join-Path $appRoot 'web/reel/encoder-worker.js') -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $workerProperty -or $workerProperty.Value -ne $sourceWorkerHash -or $packagedWorkerHash -ne $sourceWorkerHash) {
  throw 'The packaged capture worker does not match the checked production source and build manifest.'
}

# The ZIP stays intact. Only this disposable extraction gets the synthetic
# harness as its entry point; the harness loads the packaged recorder modules,
# local asset server and web/reel/encoder-worker.js from this same package.
$probeDirectory = Join-Path $appRoot 'desktop-windows/probe'
if (Test-Path -LiteralPath $probeDirectory) { throw 'The production archive unexpectedly contains the QA probe directory.' }
$captureRendererPath = Join-Path $appRoot 'desktop-windows/capture/renderer.mjs'
$sourceProbe = Join-Path $SourceRoot 'desktop-windows/probe'
$outDirectory = Join-Path $env:RUNNER_TEMP 'packaged-meeting-capture'
$isolatedAppData = Join-Path $env:RUNNER_TEMP 'packaged-capture-appdata'
$isolatedLocalAppData = Join-Path $env:RUNNER_TEMP 'packaged-capture-local-appdata'
New-Item -ItemType Directory -Path $probeDirectory, $outDirectory, $isolatedAppData, $isolatedLocalAppData | Out-Null
$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
$originalPackageJson = [IO.File]::ReadAllText($packageJsonPath)
$originalCaptureRenderer = [IO.File]::ReadAllText($captureRendererPath)
$exitCode = $null
try {
  $adapterMain = [IO.File]::ReadAllText((Join-Path $sourceProbe 'adapter-main.mjs'))
  $hookMarker = 'const failures = [];'
  if (-not $adapterMain.Contains($hookMarker)) { throw 'Could not install the QA-only renderer diagnostic hook.' }
  $diagnosticHook = @'
const qaDiagnostics = { rendererConsole: [] };
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (...args) => {
    const message = args.map(value => {
      try { return typeof value === 'string' ? value : JSON.stringify(value); }
      catch { return String(value); }
    }).join(' ');
    if (message.length) qaDiagnostics.rendererConsole.push(message.slice(0, 500));
  });
});
'@
  $adapterMain = $adapterMain.Replace($hookMarker, $hookMarker + "`r`n" + $diagnosticHook.Trim())
  $adapterMain = $adapterMain.Replace('const id = hwnd(fixtureWindow);', 'const id = hwnd(fixtureWindow); qaDiagnostics.fixtureWindowVisible = fixtureWindow.isVisible();')
  $adapterMain = $adapterMain.Replace('if (exact.length !== 1) throw Error(', 'qaDiagnostics.exactWindowSourceCount = exact.length; if (exact.length !== 1) throw Error(')
  $endpointMarker = '    recorder = createWindowsRecorder('
  if (-not $adapterMain.Contains($endpointMarker)) { throw 'Could not install the QA-only output-endpoint diagnostic.' }
  $endpointProbe = @'
    let endpointProbe;
    try {
      endpointProbe = createNativeBridge({ executable: path.join(here, '../native/ReelNativeJoin.exe') });
      qaDiagnostics.defaultRenderEndpointAvailable = Boolean(await endpointProbe.defaultRenderEndpoint());
    } catch (error) {
      qaDiagnostics.defaultRenderEndpointError = String(error?.message || error).slice(0, 300);
    } finally { await endpointProbe?.dispose(); }
'@
  $adapterMain = $adapterMain.Replace($endpointMarker, $endpointProbe + $endpointMarker)
  $finishMarker = 'async function finish(result) {'
  if (-not $adapterMain.Contains($finishMarker)) { throw 'Could not install the QA-only diagnostic result hook.' }
  $adapterMain = $adapterMain.Replace($finishMarker, $finishMarker + "`r`n  result.qaDiagnostics = qaDiagnostics;")
  [IO.File]::WriteAllText((Join-Path $probeDirectory 'adapter-main.mjs'), $adapterMain, (New-Object Text.UTF8Encoding($false)))
  Copy-Item -LiteralPath (Join-Path $sourceProbe 'fixture.html') -Destination $probeDirectory
  $rendererFailure = "} catch { fail('capture_failed'); }"
  if (-not $originalCaptureRenderer.Contains($rendererFailure)) { throw 'Could not instrument the extracted renderer failure for QA diagnostics.' }
  $instrumentedRenderer = $originalCaptureRenderer.Replace($rendererFailure,
    "} catch (error) { console.error('capture_start_failure', String(error?.name || 'Error'), String(error?.message || error)); fail('capture_failed'); }")
  [IO.File]::WriteAllText($captureRendererPath, $instrumentedRenderer, (New-Object Text.UTF8Encoding($false)))
  $package = $originalPackageJson | ConvertFrom-Json
  $package.main = 'desktop-windows/probe/adapter-main.mjs'
  [IO.File]::WriteAllText($packageJsonPath, ($package | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
  $env:APPDATA = $isolatedAppData
  $env:LOCALAPPDATA = $isolatedLocalAppData
  $argument = '"--out=' + $outDirectory + '"'
  $process = Start-Process -FilePath $exe -WorkingDirectory $PackageRoot -ArgumentList $argument -Wait -PassThru
  $exitCode = $process.ExitCode
} finally {
  [IO.File]::WriteAllText($packageJsonPath, $originalPackageJson, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($captureRendererPath, $originalCaptureRenderer, (New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
  $env:APPDATA = $originalAppData
  $env:LOCALAPPDATA = $originalLocalAppData
}

$resultPath = Join-Path $outDirectory 'result.json'
if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
  throw "Packaged runtime exited $exitCode without writing a synthetic capture result."
}
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
$resultElectron = $result.PSObject.Properties['electron']?.Value
if ($resultElectron -and $resultElectron -ne '45.2.3') { throw "Expected packaged Electron 45.2.3; got $resultElectron." }
$endpointAvailable = $result.qaDiagnostics.defaultRenderEndpointAvailable
if ($result.ok -eq $true) {
  if ($exitCode -ne 0) { throw "Packaged recorder returned success with exit code $exitCode." }
  Push-Location $SourceRoot
  try {
    node desktop-windows/probe/adapter-verify.mjs "--out=$outDirectory"
    if ($LASTEXITCODE) { throw 'Synthetic loopback capture verifier failed.' }
    & ffmpeg -v error -xerror -i $result.recording.path -f null -
    if ($LASTEXITCODE) { throw 'ffmpeg could not decode the extracted-package meeting recording.' }
  } finally { Pop-Location }
  "Loopback: Windows endpoint available; packaged meeting recorder capture/decode passed." |
    Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append
} else {
  if ($endpointAvailable -ne $false) { throw "Packaged meeting capture failed without proving endpoint absence: $($result | ConvertTo-Json -Compress -Depth 8)" }
  if ($result.qaDiagnostics.fixtureWindowVisible -ne $true -or $result.qaDiagnostics.exactWindowSourceCount -ne 1) {
    throw "The no-endpoint failure was not isolated to a visible, exactly selected synthetic window: $($result.qaDiagnostics | ConvertTo-Json -Compress -Depth 8)"
  }
  $diagnosticText = [string]::Join(' | ', [string[]]@($result.qaDiagnostics.rendererConsole))
  if ($diagnosticText -notmatch 'capture_start_failure') { throw "No synthetic renderer error was captured: $diagnosticText" }
  $recordingsRoot = Join-Path $outDirectory 'recordings'
  $completedFiles = @(
    if (Test-Path -LiteralPath $recordingsRoot) {
      Get-ChildItem -LiteralPath $recordingsRoot -Filter '*.mp4' -File -Recurse
    }
  )
  if ($completedFiles.Count) { throw 'The native loopback failure incorrectly left a completed, shareable MP4.' }
  $libraryCount = 0
  if (Test-Path -LiteralPath $recordingsRoot) {
    foreach ($libraryFile in (Get-ChildItem -LiteralPath $recordingsRoot -Filter 'library.json' -File -Recurse)) {
      $library = Get-Content -LiteralPath $libraryFile.FullName -Raw | ConvertFrom-Json
      $libraryCount += @($library.recordings).Count
    }
  }
  if ($libraryCount -ne 0) { throw 'The native loopback failure incorrectly added a recording to the library.' }
  "Loopback: no default Windows render endpoint; exact visible window selected; request failed closed and produced zero completed MP4 files. Renderer diagnostic: $diagnosticText" |
    Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append
  Write-Host "Windows loopback unavailable; packaged meeting recorder failed closed. $diagnosticText"
}

# Deterministic fallback/complement: run the exact packaged worker with a
# synthetic canvas VideoTrack and generated planar PCM AudioData, independent of
# a Windows output endpoint. This still uses the extracted Reel.exe + assets.
$encoderProbeDirectory = Join-Path $appRoot 'desktop-windows/probe'
New-Item -ItemType Directory -Path $encoderProbeDirectory | Out-Null
$encoderOutput = Join-Path $env:RUNNER_TEMP 'packaged-encoder-capture'
$encoderAppData = Join-Path $env:RUNNER_TEMP 'packaged-encoder-appdata'
$encoderLocalAppData = Join-Path $env:RUNNER_TEMP 'packaged-encoder-local-appdata'
New-Item -ItemType Directory -Path $encoderOutput, $encoderAppData, $encoderLocalAppData | Out-Null
$encoderProcessExit = $null
try {
  foreach ($file in @('encoder-main.mjs', 'encoder-fixture.html', 'encoder-fixture.mjs')) {
    Copy-Item -LiteralPath (Join-Path $QaRoot "desktop-windows/probe/$file") -Destination $encoderProbeDirectory
  }
  $package = $originalPackageJson | ConvertFrom-Json
  $package.main = 'desktop-windows/probe/encoder-main.mjs'
  [IO.File]::WriteAllText($packageJsonPath, ($package | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
  $env:APPDATA = $encoderAppData
  $env:LOCALAPPDATA = $encoderLocalAppData
  $argument = '"--out=' + $encoderOutput + '"'
  $encoderProcess = Start-Process -FilePath $exe -WorkingDirectory $PackageRoot -ArgumentList $argument -Wait -PassThru
  $encoderProcessExit = $encoderProcess.ExitCode
} finally {
  [IO.File]::WriteAllText($packageJsonPath, $originalPackageJson, (New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath $encoderProbeDirectory -Recurse -Force -ErrorAction SilentlyContinue
  $env:APPDATA = $originalAppData
  $env:LOCALAPPDATA = $originalLocalAppData
}
$encoderResultPath = Join-Path $encoderOutput 'result.json'
if (-not (Test-Path -LiteralPath $encoderResultPath -PathType Leaf)) {
  throw "Synthetic packaged encoder exited $encoderProcessExit without writing a result."
}
$encoderResult = Get-Content -LiteralPath $encoderResultPath -Raw | ConvertFrom-Json
if ($encoderProcessExit -ne 0 -or $encoderResult.ok -ne $true) {
  throw "Packaged synthetic encoder failed: $($encoderResult | ConvertTo-Json -Compress -Depth 8)"
}
Push-Location $QaRoot
try {
  node desktop-windows/probe/verify-encoder-capture.mjs "--out=$encoderOutput"
  if ($LASTEXITCODE) { throw 'Synthetic packaged worker video/PCM decode verifier failed.' }
} finally { Pop-Location }
"Packaged encoder: Electron 45.2.3 $ExpectedArchitecture; synthetic video + generated PCM encoded, muxed and decoded; worker SHA-256 $sourceWorkerHash." |
  Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append
Write-Host "Packaged capture/encoder checks passed: Electron 45.2.3 $ExpectedArchitecture (session $sessionId, worker SHA-256 $sourceWorkerHash)."
