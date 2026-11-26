# Build on Windows. Supply an extracted official Electron 45.2.3 Windows distribution.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ElectronDist,
    [Parameter(Mandatory = $true)][string]$GoogleDesktopClientId,
    [Parameter(Mandatory = $true)][string]$GoogleDesktopCredentialsFile,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputZip,
    [ValidateSet('arm64', 'x64', 'ia32')][string]$ExpectedArchitecture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this builder on Windows.' }
if ($GoogleDesktopClientId -notmatch '^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$') {
    throw 'Supply the public Google Desktop OAuth client ID.'
}
$repo = Split-Path $PSScriptRoot -Parent
$organization = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'organization.json') | ConvertFrom-Json
if ($organization.googleDesktopClientId -cne $GoogleDesktopClientId) {
    throw 'GoogleDesktopClientId must match the configured organization.'
}
# Only the matching installed/Desktop client pair is distributable configuration.
# Keep the downloaded JSON outside this checkout; never copy or print its contents.
try {
    $credentialFile = Get-Item -LiteralPath $GoogleDesktopCredentialsFile
    if ($credentialFile -isnot [IO.FileInfo] -or $credentialFile.Length -lt 1 -or $credentialFile.Length -gt 32768) { throw 'invalid' }
    if ($credentialFile.FullName.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'invalid' }
    $ancestor = $credentialFile
    while ($null -ne $ancestor) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
        $ancestor = if ($ancestor -is [IO.FileInfo]) { $ancestor.Directory } else { $ancestor.Parent }
    }
    $credentials = [IO.File]::ReadAllText($credentialFile.FullName) | ConvertFrom-Json
    if ($credentials -isnot [System.Management.Automation.PSCustomObject] -or
        @($credentials.PSObject.Properties.Name).Count -ne 1 -or
        $credentials.PSObject.Properties.Name -cne 'installed' -or
        $credentials.installed -isnot [System.Management.Automation.PSCustomObject]) { throw 'invalid' }
    $installed = $credentials.installed
    if ($installed.client_id -isnot [string] -or $installed.client_id -cne $GoogleDesktopClientId -or
        $installed.client_secret -isnot [string] -or $installed.client_secret -cnotmatch '^[A-Za-z0-9_-]{1,256}$') { throw 'invalid' }
    $desktopClientSecret = $installed.client_secret
} catch {
    throw 'Supply an external Desktop credentials JSON file (installed object, matching client ID, valid client value, maximum 32 KiB); web and service-account credentials are not accepted.'
}
$runtime = (Resolve-Path -LiteralPath $ElectronDist).Path
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputZip)
if ([IO.Path]::GetExtension($output) -ne '.zip') { throw 'OutputZip must end in .zip.' }
if (Test-Path -LiteralPath $output) { throw 'Output already exists; choose a new archive name.' }
foreach ($required in @('electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'resources')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $required))) { throw "Electron distribution missing $required" }
}
# Inspect the executable, not the host architecture (x64 Electron can run on ARM64).
$pe = [IO.File]::ReadAllBytes((Join-Path $runtime 'electron.exe'))
$peOffset = [BitConverter]::ToInt32($pe, 0x3c)
if ([BitConverter]::ToUInt32($pe, $peOffset) -ne 0x4550) { throw 'Invalid Electron PE executable.' }
$machine = [BitConverter]::ToUInt16($pe, $peOffset + 4)
$arch = switch ($machine) { 0xaa64 { 'arm64' }; 0x8664 { 'x64' }; 0x014c { 'ia32' }; default { throw 'Unsupported Electron architecture.' } }
if ($ExpectedArchitecture -and $arch -ne $ExpectedArchitecture) {
    throw "Expected the $ExpectedArchitecture Electron distribution; found $arch."
}
$oldRunAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
$runtimeStdout = [IO.Path]::GetTempFileName()
$runtimeStderr = [IO.Path]::GetTempFileName()
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    # PowerShell 5.1 does not wait for GUI executables invoked with &. The fixed
    # JavaScript contains no embedded quotes; explicitly quote it as one argument.
    $runtimeArguments = '-e "console.log(JSON.stringify({electron:process.versions.electron,arch:process.arch,platform:process.platform}))"'
    $runtimeProcess = Start-Process -FilePath (Join-Path $runtime 'electron.exe') -ArgumentList $runtimeArguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $runtimeStdout -RedirectStandardError $runtimeStderr
    if ($runtimeProcess.ExitCode -ne 0) { throw "Electron runtime inspection failed (exit $($runtimeProcess.ExitCode))." }
    $runtimeJson = [IO.File]::ReadAllText($runtimeStdout).Trim()
    if (-not $runtimeJson) { throw 'Electron runtime inspection returned no version information.' }
    $runtimeInfo = $runtimeJson | ConvertFrom-Json
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $oldRunAsNode, 'Process')
    Remove-Item -LiteralPath $runtimeStdout, $runtimeStderr -Force -ErrorAction SilentlyContinue
}
if ($runtimeInfo.electron -ne '45.2.3' -or $runtimeInfo.platform -ne 'win32' -or $runtimeInfo.arch -ne $arch) {
    throw 'Supply Electron 45.2.3 for Windows with matching runtime and PE architecture.'
}
# Explicit allowlist: no recursive source-tree copies, downloaded credentials, fixtures or tests.
$productFiles = @(
    'desktop-windows/organization.json', 'web/reel/organization.js',
    'desktop-windows/main.mjs', 'desktop-windows/preload.cjs',
    'desktop-windows/src/auth.mjs', 'desktop-windows/src/asset-server.mjs',
    'desktop-windows/src/desktop-service.mjs', 'desktop-windows/src/google-calendar.mjs', 'desktop-windows/src/meeting-reminders.mjs',
    'desktop-windows/src/local-recordings.mjs', 'desktop-windows/src/meeting-coordinator.mjs', 'desktop-windows/src/meeting-processing.mjs', 'desktop-windows/src/meeting-share.mjs',
    'desktop-windows/src/native-bridge.mjs', 'desktop-windows/src/recorder.mjs',
    'desktop-windows/src/trim-range.mjs',
    'desktop-windows/ui/index.html', 'desktop-windows/ui/setup.css', 'desktop-windows/ui/setup.mjs',
    'desktop-windows/capture/index.html', 'desktop-windows/capture/preload.cjs', 'desktop-windows/capture/renderer.mjs',
    'web/reel/capture.js', 'web/reel/core.js', 'web/reel/whisper-languages.js', 'web/reel/cloud.js', 'web/reel/audio.js', 'web/reel/encoder-worker.js', 'web/reel/fmp4.js',
    'web/vendor/mp4-muxer.mjs', 'web/vendor/mp4-muxer.LICENSE'
)
$nativeInputs = @('Core.cs', 'WinJoin.cs', 'Program.cs', 'PolicyTests.cs', 'FixturePolicyTests.cs', 'ProcessIsolationTests.cs',
    'MediaTrim.cs', 'MediaTrimProgram.cs', 'MediaTrimTests.cs', 'build.cmd', 'build-media-trim.ps1')
$sourceHashes = [ordered]@{}
foreach ($relative in $productFiles) {
    $sourceHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
foreach ($name in $nativeInputs) {
    $relative = "desktop-windows/native/$name"
    $sourceHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
# Never accept a stale helper or a fixture variant as the production binary.
$helper = Join-Path $PSScriptRoot 'native/ReelNativeJoin.exe'
if (Test-Path -LiteralPath $helper) { Remove-Item -LiteralPath $helper }
& $env:ComSpec /d /c "`"$(Join-Path $PSScriptRoot 'native/build.cmd')`""
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helper)) { throw 'Fresh production native build/policy checks failed.' }
foreach ($relative in @($sourceHashes.Keys)) {
    if ((Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHashes[$relative]) {
        throw "Source changed during build: $relative"
    }
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ('reel-portable-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $runtime -Force | Copy-Item -Destination $stage -Recurse -Force
    # The sample application is not part of Reel. Keep Electron's vendor licenses.
    $resources = Join-Path $stage 'resources'
    foreach ($entry in @('app', 'app.asar', 'default_app.asar')) {
        $path = Join-Path $resources $entry
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    $appRoot = Join-Path $resources 'app'
    foreach ($relative in $productFiles) {
        $destination = Join-Path $appRoot $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination
    }
    $nativeDestination = Join-Path $appRoot 'desktop-windows/native'
    New-Item -ItemType Directory -Path $nativeDestination | Out-Null
    Copy-Item -LiteralPath $helper -Destination (Join-Path $nativeDestination 'ReelNativeJoin.exe')
    $trimHelper = Join-Path $PSScriptRoot 'native/ReelMediaTrim.exe'
    if (-not (Test-Path -LiteralPath $trimHelper -PathType Leaf)) { throw 'The Windows media trim helper was not built.' }
    $trimHelperHash = (Get-FileHash -LiteralPath $trimHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $trimHelper -Destination (Join-Path $nativeDestination 'ReelMediaTrim.exe')
    # UTF-8 without BOM also works with Node's JSON loader on Windows PowerShell 5.1.
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), (@{
        name = 'reel-windows-desktop'; productName = 'Reel'; version = $Version
        private = $true; type = 'module'; main = 'desktop-windows/main.mjs'
    } | ConvertTo-Json), $utf8)
    [IO.File]::WriteAllText((Join-Path $appRoot 'desktop-windows/config.json'), (@{
        googleDesktopClientId = $GoogleDesktopClientId
        googleDesktopClientSecret = $desktopClientSecret
    } | ConvertTo-Json), $utf8)
    Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'Reel.exe'
    $helperHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($relative in $productFiles) {
        if ((Get-FileHash -LiteralPath (Join-Path $appRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHashes[$relative]) {
            throw "Packaged source differs from verified build input: $relative"
        }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $nativeDestination 'ReelNativeJoin.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $helperHash) {
        throw 'Packaged native helper differs from the fresh build.'
    }
    if ((Get-FileHash -LiteralPath (Join-Path $nativeDestination 'ReelMediaTrim.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $trimHelperHash) {
        throw 'Packaged media trim helper differs from the freshly tested build.'
    }
    $expectedAppFiles = @($productFiles) + @('package.json', 'desktop-windows/config.json', 'desktop-windows/native/ReelNativeJoin.exe', 'desktop-windows/native/ReelMediaTrim.exe')
    $actualAppFiles = @(Get-ChildItem -LiteralPath $appRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($appRoot.Length + 1).Replace('\', '/') })
    if (@(Compare-Object $expectedAppFiles $actualAppFiles).Count -ne 0) { throw 'Unexpected application package contents.' }
    $manifest = [ordered]@{
        version = $Version; electron = $runtimeInfo.electron; platform = 'win32'; architecture = $arch
        createdAtUtc = [DateTime]::UtcNow.ToString('o'); distribution = 'unsigned portable test build'
        executableVersionNote = 'Reel.exe retains upstream Electron executable version resources.'
        nativeHelper = @{ sha256 = $helperHash; build = 'native/build.cmd: fresh production compile and policy checks'; target = 'managed .NET Framework (compiler default)' }
        mediaTrimHelper = @{ sha256 = $trimHelperHash; build = 'native/build-media-trim.ps1: fresh AnyCPU compile and synthetic MP4 export test'; target = 'Windows Media Foundation through Windows.Media.Editing' }
        sourceSha256 = $sourceHashes; applicationFiles = $expectedAppFiles
        releaseChecks = 'Signing, real Google/Calendar/meeting UI verification and public download verification require separate evidence.'
    }
    [IO.File]::WriteAllText((Join-Path $stage 'build-info.json'), ($manifest | ConvertTo-Json -Depth 6), $utf8)
    New-Item -ItemType Directory -Force -Path (Split-Path $output -Parent) | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # CreateFromDirectory fails if output exists; no overwrite even if another build races us.
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $output, [IO.Compression.CompressionLevel]::Optimal, $false)
    $zip = [IO.Compression.ZipFile]::OpenRead($output)
    try {
        # .NET Framework ZIP writers can use backslashes on Windows.
        $zipAppFiles = @($zip.Entries | ForEach-Object {
            $entryName = $_.FullName.Replace('\', '/')
            if ($entryName.StartsWith('resources/app/') -and -not $entryName.EndsWith('/')) {
                $entryName.Substring('resources/app/'.Length)
            }
        })
        if (@(Compare-Object $expectedAppFiles $zipAppFiles).Count -ne 0) { throw 'ZIP application contents do not match the allowlist.' }
        foreach ($required in @('Reel.exe', 'LICENSE', 'LICENSES.chromium.html', 'build-info.json')) {
            if ($null -eq $zip.GetEntry($required)) { throw "ZIP missing $required" }
        }
    } finally { $zip.Dispose() }
    Write-Output "Created unsigned portable test build: $output"
    Write-Output "Electron $($runtimeInfo.electron), Windows $arch; native policy checks, media trim/export smoke and ZIP allowlist passed."
    Write-Output "SHA256 $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
