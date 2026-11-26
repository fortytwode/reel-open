[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
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
if ($buildInfo.architecture -ne $ExpectedArchitecture -or $buildInfo.electron -ne '45.2.3') {
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
$sourceProbe = Join-Path $SourceRoot 'desktop-windows/probe'
$outDirectory = Join-Path $env:RUNNER_TEMP 'packaged-meeting-capture'
$isolatedAppData = Join-Path $env:RUNNER_TEMP 'packaged-capture-appdata'
$isolatedLocalAppData = Join-Path $env:RUNNER_TEMP 'packaged-capture-local-appdata'
New-Item -ItemType Directory -Path $probeDirectory, $outDirectory, $isolatedAppData, $isolatedLocalAppData | Out-Null
$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
$originalPackageJson = [IO.File]::ReadAllText($packageJsonPath)
$exitCode = $null
try {
  Copy-Item -LiteralPath (Join-Path $sourceProbe 'adapter-main.mjs') -Destination $probeDirectory
  Copy-Item -LiteralPath (Join-Path $sourceProbe 'fixture.html') -Destination $probeDirectory
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
  Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
  $env:APPDATA = $originalAppData
  $env:LOCALAPPDATA = $originalLocalAppData
}

$resultPath = Join-Path $outDirectory 'result.json'
if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
  throw "Packaged runtime exited $exitCode without writing a synthetic capture result."
}
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if ($exitCode -ne 0 -or $result.ok -ne $true) { throw "Packaged capture failed: $($result | ConvertTo-Json -Compress -Depth 8)" }
if ($result.electron -ne '45.2.3') { throw "Expected packaged Electron 45.2.3; got $($result.electron)." }

Push-Location $SourceRoot
try {
  node desktop-windows/probe/adapter-verify.mjs "--out=$outDirectory"
  if ($LASTEXITCODE) { throw 'Synthetic capture verifier failed.' }
  & ffmpeg -v error -xerror -i $result.recording.path -f null -
  if ($LASTEXITCODE) { throw 'ffmpeg could not decode the extracted-package recording.' }
} finally { Pop-Location }
Write-Host "Packaged capture/decode passed: Electron 45.2.3 $ExpectedArchitecture (session $sessionId, worker SHA-256 $sourceWorkerHash)."
