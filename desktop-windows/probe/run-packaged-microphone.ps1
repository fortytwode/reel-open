param(
  [Parameter(Mandatory)][string]$SourceRoot,
  [Parameter(Mandatory)][string]$QaRoot,
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][ValidateSet('arm64','x64')][string]$ExpectedArchitecture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'A desktop session is required.' }
$appRoot = Join-Path $PackageRoot 'resources/app'
$zip = Join-Path $env:RUNNER_TEMP 'demo-portable.zip'
$archiveHash = (Get-FileHash $zip).Hash
$build = Get-Content -LiteralPath (Join-Path $PackageRoot 'build-info.json') -Raw | ConvertFrom-Json
if ($build.architecture -ne $ExpectedArchitecture -or $build.electron -ne '45.2.3') { throw 'Wrong packaged runtime.' }
foreach ($path in @('desktop-windows/src/recorder.mjs','desktop-windows/capture/renderer.mjs','web/reel/capture.js','web/reel/encoder-worker.js')) {
  $sourceHash = (Get-FileHash -LiteralPath (Join-Path $SourceRoot $path)).Hash.ToLowerInvariant()
  if ((Get-FileHash -LiteralPath (Join-Path $appRoot $path)).Hash.ToLowerInvariant() -ne $sourceHash -or
      $build.sourceSha256.PSObject.Properties[$path].Value -ne $sourceHash) { throw "Package source mismatch: $path" }
}

$entryPath = Join-Path $appRoot 'package.json'
$renderer = Join-Path $appRoot 'desktop-windows/capture/renderer.mjs'
$probe = Join-Path $appRoot 'desktop-windows/probe'
$originalEntry = [IO.File]::ReadAllBytes($entryPath)
$originalRenderer = [IO.File]::ReadAllBytes($renderer)
$runtime = Join-Path $PackageRoot 'Reel.exe'
if (Test-Path -LiteralPath $probe) { throw 'Expected no synthetic fixture in the package.' }
$oldApp = $env:APPDATA
$oldLocal = $env:LOCALAPPDATA
try {
  New-Item -ItemType Directory -Path $probe | Out-Null
  Copy-Item -LiteralPath (Join-Path $SourceRoot 'desktop-windows/probe/fixture.html') -Destination $probe
  $adapter = [IO.File]::ReadAllText((Join-Path $SourceRoot 'desktop-windows/probe/adapter-main.mjs'))
  $old = 'const failures = [];'
  if (-not $adapter.Contains($old)) { throw 'Missing adapter fixture marker.' }
  $configuration = @'
const failures = [];
const micOn = process.argv.includes('--mic-on');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(here, 'virtual-mic.wav'));
'@
  $adapter = $adapter.Replace($old,$configuration)
  $adapter = $adapter.Replace('microphone: false, signal: controller.signal','microphone: micOn, signal: controller.signal')
  $adapter = $adapter.Replace('await sleep(Math.max(0, 13_500 - (Date.now() - beganAt)));','await sleep(13_500);')
  $adapter = $adapter.Replace('error: { name:','error: { code: error?.code, name:')
  [IO.File]::WriteAllText((Join-Path $probe 'adapter-main.mjs'),$adapter)
  ffmpeg -v error -f lavfi -i 'sine=frequency=880:sample_rate=48000' -t 20 -af 'volume=3' -ac 1 (Join-Path $probe 'virtual-mic.wav')
  if ($LASTEXITCODE) { throw 'Could not generate the fake microphone input.' }

  # Only replace the Windows speaker track in the disposable extraction. The
  # hosted machine lacks a normal output endpoint. Keep exact window video, the
  # shipped permission handler and the shipped microphone acquisition intact.
  $source = [IO.File]::ReadAllText($renderer)
  $start = $source.IndexOf('function acquireWindow(id) {')
  if ($start -lt 0) { throw 'Missing loopback acquisition start.' }
  $end = $source.IndexOf('async function refreshAudio(', $start)
  if ($end -le $start) { throw 'Missing loopback acquisition end.' }
  $replacement = @'
const BrowserAudioContext = globalThis.AudioContext;
globalThis.AudioContext = class extends BrowserAudioContext {
  constructor(options) { super({ ...options, sinkId: { type: 'none' } }); }
};
async function acquireWindow(id) {
  const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: id };
  const windowVideo = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { ...mandatory, maxWidth: 960, maxHeight: 600, maxFrameRate: 15 } },
    audio: false,
  });
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const tone = context.createOscillator();
  tone.frequency.value = 440;
  const gain = context.createGain();
  gain.gain.value = 0.2;
  const output = context.createMediaStreamDestination();
  tone.connect(gain).connect(output);
  tone.start();
  return new MediaStream([...windowVideo.getVideoTracks(), ...output.stream.getAudioTracks()]);
}
'@
  [IO.File]::WriteAllText($renderer, $source.Substring(0,$start) + $replacement + [Environment]::NewLine + $source.Substring($end))
  $package = [Text.Encoding]::UTF8.GetString($originalEntry) | ConvertFrom-Json
  $package.main = 'desktop-windows/probe/adapter-main.mjs'
  [IO.File]::WriteAllText($entryPath,($package | ConvertTo-Json -Depth 20))

  foreach ($mode in @('off','on')) {
    $out = Join-Path $env:RUNNER_TEMP "mic-$mode"
    $env:APPDATA = Join-Path $env:RUNNER_TEMP "mic-$mode-appdata"
    $env:LOCALAPPDATA = Join-Path $env:RUNNER_TEMP "mic-$mode-local"
    New-Item -ItemType Directory -Path $out,$env:APPDATA,$env:LOCALAPPDATA | Out-Null
    $arguments = @(([char]34 + "--out=$out" + [char]34))
    if ($mode -eq 'on') { $arguments += '--mic-on' }
    $process = Start-Process -FilePath $runtime -ArgumentList $arguments -Wait -PassThru
    $resultPath = Join-Path $out 'result.json'
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Capture $mode produced no receipt. Exit $($process.ExitCode)." }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($process.ExitCode -ne 0 -or $result.ok -ne $true) { throw "Capture $mode failed: $($result | ConvertTo-Json -Depth 8 -Compress)" }
    node (Join-Path $SourceRoot 'desktop-windows/probe/adapter-verify.mjs') "--out=$out"
    if ($LASTEXITCODE) { throw "The exact-window video and 440 Hz fixture did not survive $mode." }
    ffmpeg -v error -xerror -i $result.recording.path -f null -
    if ($LASTEXITCODE) { throw "FFmpeg could not decode the complete $mode recording." }
    node (Join-Path $QaRoot 'desktop-windows/probe/verify-packaged-microphone.mjs') $out $mode
    if ($LASTEXITCODE) { throw "The recording did not match the microphone choice $mode." }
  }
} finally {
  [IO.File]::WriteAllBytes($entryPath,$originalEntry)
  [IO.File]::WriteAllBytes($renderer,$originalRenderer)
  if (Test-Path -LiteralPath $probe) { Remove-Item -Force -Recurse -LiteralPath $probe }
  $env:APPDATA = $oldApp
  $env:LOCALAPPDATA = $oldLocal
}
if ((Get-FileHash $zip).Hash -ne $archiveHash) { throw 'Verification altered the package archive.' }
'Microphone permission, exact-window video, and opt-in audio passed using the packaged Windows runtime.' |
  Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append
