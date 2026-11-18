param(
  [string]$ElectronExecutable = (Join-Path $PSScriptRoot 'probe\node_modules\electron\dist\electron.exe')
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or (Get-Process -Id $PID).SessionId -eq 0) {
  throw 'Run this check in a logged-in Windows desktop session; Session 0 is not a capture test.'
}
foreach ($program in @('node', 'ffmpeg', 'ffprobe')) { Get-Command $program -ErrorAction Stop | Out-Null }
if (-not (Test-Path $ElectronExecutable -PathType Leaf)) { throw 'Install the pinned probe dependency with npm ci in desktop-windows/probe first.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $PSScriptRoot "probe\out\local-ci-$stamp"
New-Item -ItemType Directory -Path $out | Out-Null
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program exited with $LASTEXITCODE" }
}
function Invoke-Electron([string[]]$Arguments, [switch]$ExpectFailure) {
  # PowerShell does not wait for a GUI executable invoked with &. Preserve each
  # native argument (including paths with spaces) and collect its actual exit.
  $quoted = @($Arguments | ForEach-Object {
    '"' + [regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
  }) -join ' '
  $process = Start-Process -FilePath $ElectronExecutable -ArgumentList $quoted -NoNewWindow -Wait -PassThru
  $code = $process.ExitCode
  if (($ExpectFailure -and $code -eq 0) -or (-not $ExpectFailure -and $code -ne 0)) {
    throw "Electron exited with $code (expected failure: $ExpectFailure)"
  }
}
$tests = @(Get-ChildItem (Join-Path $PSScriptRoot 'tests\*.test.mjs') | ForEach-Object { $_.FullName })
$tests += Join-Path $PSScriptRoot 'probe\source-selection.test.mjs'
Invoke-Checked -Program 'node' -Arguments (@('--test') + $tests)
Invoke-Checked -Program (Join-Path $PSScriptRoot 'native\build.cmd') -Arguments @()
$probe = Join-Path $PSScriptRoot 'probe\main.mjs'
Invoke-Electron -Arguments @($probe, '--invalid-source', "--out=$out\unknown")
Invoke-Electron -Arguments @($probe, '--no-capture', "--out=$out\noop") -ExpectFailure
$noop = Get-Content (Join-Path $out 'noop\result.json') -Raw | ConvertFrom-Json
if ($noop.ok -ne $false -or $noop.error.name -ne 'NoopControl') { throw 'The no-capture control failed for an unexpected reason.' }
$adapter = Join-Path $PSScriptRoot 'probe\adapter-main.mjs'
Invoke-Electron -Arguments @($adapter, '--abort-negative', "--out=$out\abort")
$abort = Get-Content (Join-Path $out 'abort\result.json') -Raw | ConvertFrom-Json
if ($abort.expectedAbort -ne $true -or $abort.completedRecordings -ne 0) { throw 'Startup cancellation did not fail closed.' }
Invoke-Electron -Arguments @($adapter, "--out=$out\capture")
Invoke-Checked -Program 'node' -Arguments @((Join-Path $PSScriptRoot 'probe\adapter-verify.mjs'), "--out=$out\capture")
$capture = Get-Content (Join-Path $out 'capture\result.json') -Raw | ConvertFrom-Json
Invoke-Checked -Program 'ffmpeg' -Arguments @('-v', 'error', '-i', $capture.recording.path, '-f', 'null', '-')
@{ result = 'PASS'; sessionId = (Get-Process -Id $PID).SessionId; finishedAt = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content (Join-Path $out 'local-ci.json') -Encoding utf8
Write-Host "Local Windows CI passed. Evidence: $out"
