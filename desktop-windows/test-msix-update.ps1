# Disposable-runner integration test for MSIX install, App Installer binding and upgrade.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ElectronDist,
    [Parameter(Mandatory = $true)][string]$GoogleDesktopClientId,
    [Parameter(Mandatory = $true)][string]$GoogleDesktopCredentialsFile,
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [string]$Version = '0.1.3.0',
    [string]$NextVersion = '0.1.4.0'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true') {
    throw 'This test may install ephemeral trust only on a disposable GitHub Actions Windows runner.'
}
if ([version]$NextVersion -le [version]$Version) { throw 'NextVersion must be greater than Version.' }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The disposable runner must be an administrator to install and remove ephemeral MSIX test trust.'
}

$publisher = 'CN=Reel Ephemeral CI Test ' + [guid]::NewGuid().ToString('N')
$identity = 'RocketShipHQ.Reel'
if (Get-AppxPackage -Name $identity -ErrorAction SilentlyContinue) {
    throw 'Refusing to run while any Reel package is already installed in the test account.'
}
foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPeople')) {
    if (Get-ChildItem $store -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq $publisher }) {
        throw 'Refusing to reuse an existing test signing certificate.'
    }
}
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('reel-msix-update-' + [guid]::NewGuid().ToString('N'))
$serveRoot = Join-Path $tempRoot 'feed'
New-Item -ItemType Directory -Path $serveRoot | Out-Null
$certificate = $null
$trustedCertificate = $null
$rootCertificate = $null
$server = $null

function Find-SignTool {
    $root = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    foreach ($candidate in (Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name -Descending)) {
        $path = Join-Path $candidate.FullName 'x64\signtool.exe'
        if (Test-Path -LiteralPath $path) { return $path }
    }
    throw 'Windows SDK SignTool is missing.'
}

function Sign-TestPackage([string]$path, [string]$tool, [string]$thumbprint) {
    & $tool sign /fd SHA256 /sha1 $thumbprint /s My $path
    if ($LASTEXITCODE -ne 0) { throw 'Could not sign the test MSIX.' }
    & $tool verify /pa /v $path
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the test MSIX signature.' }
}

try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $baseUri = "http://127.0.0.1:$port"
    $feedName = "latest-$Architecture.appinstaller"
    $python = (Get-Command python -ErrorAction Stop).Source
    $serverStdout = Join-Path $tempRoot 'http.out.log'
    $serverStderr = Join-Path $tempRoot 'http.err.log'
    $rangeProbe = Join-Path $serveRoot 'range-probe.msix'
    [IO.File]::WriteAllBytes($rangeProbe, [byte[]](65..72))
    $serverScript = Join-Path $PSScriptRoot 'msix-test-server.py'
    $server = Start-Process -FilePath $python -ArgumentList @($serverScript, '--port', "$port", '--directory', $serveRoot, '--bind', '127.0.0.1') `
        -PassThru -NoNewWindow -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        try { $null = Invoke-WebRequest -UseBasicParsing "$baseUri/"; break } catch { }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($server.HasExited) { throw 'The local App Installer feed server did not start.' }
    Write-Output 'Checking byte-range, MIME, Content-Length, and HEAD behavior before package install.'
    $head = Invoke-WebRequest -UseBasicParsing -Method Head "$baseUri/range-probe.msix"
    if ($head.StatusCode -ne 200 -or $head.Headers['Content-Length'] -ne '8'
        -or $head.Headers['Content-Type'] -ne 'application/msix' -or $head.Headers['Accept-Ranges'] -ne 'bytes') {
        throw 'The local MSIX server HEAD response is missing required metadata.'
    }
    $range = Invoke-WebRequest -UseBasicParsing -Headers @{ Range = 'bytes=0-0' } "$baseUri/range-probe.msix"
    if ($range.StatusCode -ne 206 -or $range.Headers['Content-Length'] -ne '1'
        -or $range.Headers['Content-Range'] -ne 'bytes 0-0/8' -or $range.Content.Length -ne 1) {
        throw 'The local MSIX server does not correctly serve a byte-range GET.'
    }
    Remove-Item -LiteralPath $rangeProbe -Force

    Write-Output 'Creating a unique, one-day MSIX test certificate on the disposable runner.'
    $certificate = New-SelfSignedCertificate -Subject $publisher -Type CodeSigningCert -KeySpec Signature `
        -KeyLength 2048 -HashAlgorithm SHA256 -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(1)
    $cer = Join-Path $tempRoot 'test-publisher.cer'
    Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
    $trustedCertificate = Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
    $rootCertificate = Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\Root'
    $signTool = Find-SignTool

    foreach ($release in @(@{ Version = $Version; Name = 'v1' }, @{ Version = $NextVersion; Name = 'v2' })) {
        Write-Output "Building and signing test package version $($release.Version) ($Architecture)."
        $msixName = 'Reel-{0}-win32-{1}.msix' -f $release.Version.Substring(0, $release.Version.LastIndexOf('.')), $Architecture
        $msix = Join-Path $serveRoot $msixName
        $feed = Join-Path $tempRoot ($release.Name + '.appinstaller')
        $packageUri = [uri]"$baseUri/$msixName"
        $appInstallerUri = [uri]"$baseUri/$feedName"
        & (Join-Path $PSScriptRoot 'build-msix.ps1') -ElectronDist $ElectronDist `
            -GoogleDesktopClientId $GoogleDesktopClientId -GoogleDesktopCredentialsFile $GoogleDesktopCredentialsFile `
            -Version $release.Version -Architecture $Architecture -Publisher $publisher `
            -AppInstallerUri $appInstallerUri -PackageUri $packageUri -OutputMsix $msix `
            -OutputAppInstaller $feed -UpdateCheckHours 0 -AllowLoopbackHttp
        Sign-TestPackage $msix $signTool $certificate.Thumbprint
        if ($release.Name -eq 'v1') {
            Copy-Item -LiteralPath $feed -Destination (Join-Path $serveRoot $feedName)
        }
    }

    $initialFeed = Join-Path $serveRoot $feedName
    Write-Output 'Installing the first package from its App Installer feed.'
    Add-AppxPackage -AppInstallerFile $initialFeed
    $installed = Get-AppxPackage -Name $identity
    if ($null -eq $installed -or $installed.Version.ToString() -ne $Version) {
        throw 'App Installer did not install the initial package version.'
    }

    # Publish the newer feed at the same URI registered by the initial install.
    Write-Output 'Publishing the newer feed at the registered update URI.'
    Copy-Item -LiteralPath (Join-Path $tempRoot 'v2.appinstaller') -Destination $initialFeed -Force
    $launcher = "shell:AppsFolder\$($installed.PackageFamilyName)!Companion"
    Write-Output 'Launching the installed Companion app to trigger the App Installer update check.'
    Start-Process -FilePath explorer.exe -ArgumentList $launcher
    Write-Output "Waiting for Windows to install version $NextVersion from the registered feed."
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    do {
        Start-Sleep -Seconds 2
        $installed = Get-AppxPackage -Name $identity
        if ($null -ne $installed -and $installed.Version.ToString() -eq $NextVersion) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $installed -or $installed.Version.ToString() -ne $NextVersion) {
        throw 'The installed app did not upgrade from its stable App Installer URI on launch.'
    }
    Write-Output "MSIX App Installer install/upgrade passed: $Version -> $NextVersion ($Architecture)."
} finally {
    Write-Output 'Removing the test package, local server, and per-run trust certificate.'
    $testPackage = Get-AppxPackage -Name $identity -ErrorAction SilentlyContinue |
        Where-Object { $_.Publisher -eq $publisher } | Select-Object -First 1
    if ($testPackage) {
        $testPackageInstallPath = [IO.Path]::GetFullPath($testPackage.InstallLocation)
        Get-CimInstance Win32_Process -Filter "Name = 'Reel.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq (Join-Path $testPackageInstallPath 'Reel.exe') } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Remove-AppxPackage -Package $testPackage.PackageFullName -ErrorAction SilentlyContinue
    }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    if ($trustedCertificate) {
        Remove-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$($trustedCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if ($rootCertificate) {
        Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$($rootCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if ($certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
