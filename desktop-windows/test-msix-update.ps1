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
if ($env:OS -ne 'Windows_NT') { throw 'Run this update test on disposable Windows CI.' }
if ([version]$NextVersion -le [version]$Version) { throw 'NextVersion must be greater than Version.' }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('reel-msix-update-' + [guid]::NewGuid().ToString('N'))
$serveRoot = Join-Path $tempRoot 'feed'
New-Item -ItemType Directory -Path $serveRoot | Out-Null
$publisher = 'CN=Reel Ephemeral CI Test'
$identity = 'RocketShipHQ.Reel'
$certificate = $null
$trustedCertificate = $null
$rootCertificate = $null
$server = $null
$appInstalled = $false
$testPassword = 'ephemeral-' + [guid]::NewGuid().ToString('N')

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
    $server = Start-Process -FilePath $python -ArgumentList @('-m', 'http.server', "$port", '--directory', $serveRoot, '--bind', '127.0.0.1') `
        -PassThru -NoNewWindow -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        try { $null = Invoke-WebRequest -UseBasicParsing "$baseUri/"; break } catch { }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($server.HasExited) { throw 'The local App Installer feed server did not start.' }

    $certificate = New-SelfSignedCertificate -Subject $publisher -Type CodeSigningCert -KeySpec Signature `
        -KeyLength 2048 -HashAlgorithm SHA256 -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(1)
    $cer = Join-Path $tempRoot 'test-publisher.cer'
    Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
    $trustedCertificate = Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople'
    $rootCertificate = Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\CurrentUser\Root'
    $signTool = Find-SignTool

    foreach ($release in @(@{ Version = $Version; Name = 'v1' }, @{ Version = $NextVersion; Name = 'v2' })) {
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
        } else {
            $nextFeed = Join-Path $serveRoot $feedName
        }
    }

    $initialFeed = Join-Path $serveRoot $feedName
    Add-AppxPackage -AppInstallerFile $initialFeed
    $installed = Get-AppxPackage -Name $identity
    if ($null -eq $installed -or $installed.Version.ToString() -ne $Version) {
        throw 'App Installer did not install the initial package version.'
    }
    $appInstalled = $true

    # Publish the newer feed at the same URI registered by the initial install.
    Copy-Item -LiteralPath (Join-Path $tempRoot 'v2.appinstaller') -Destination $initialFeed -Force
    $launcher = "shell:AppsFolder\$($installed.PackageFamilyName)!Companion"
    Start-Process -FilePath explorer.exe -ArgumentList $launcher
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
    Get-Process -Name Reel -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-AppxPackage -Name $identity -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    if ($trustedCertificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\TrustedPeople\$($trustedCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if ($rootCertificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\Root\$($rootCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if ($certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
