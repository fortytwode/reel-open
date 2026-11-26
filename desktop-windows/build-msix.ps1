# Create an unsigned MSIX and its stable App Installer feed file on Windows.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ElectronDist,
    [Parameter(Mandatory = $true)][string]$GoogleDesktopClientId,
    [Parameter(Mandatory = $true)][string]$GoogleDesktopCredentialsFile,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Architecture,
    [Parameter(Mandatory = $true)][string]$Publisher,
    [Parameter(Mandatory = $true)][uri]$AppInstallerUri,
    [Parameter(Mandatory = $true)][uri]$PackageUri,
    [Parameter(Mandatory = $true)][string]$OutputMsix,
    [Parameter(Mandatory = $true)][string]$OutputAppInstaller,
    [ValidateRange(0, 255)][int]$UpdateCheckHours = 12,
    [switch]$AllowLoopbackHttp
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run the MSIX builder on Windows.' }
foreach ($uri in @($AppInstallerUri, $PackageUri)) {
    if ($uri.Scheme -eq 'https') { continue }
    if (-not ($AllowLoopbackHttp -and $uri.Scheme -eq 'http' -and $uri.Host -in @('localhost', '127.0.0.1', '::1'))) {
        throw 'Release App Installer and package URIs must use HTTPS; local HTTP is test-only.'
    }
}
$repo = Split-Path $PSScriptRoot -Parent
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('reel-msix-' + [guid]::NewGuid().ToString('N'))
$portableZip = Join-Path $tempRoot 'portable.zip'
$packageRoot = Join-Path $tempRoot 'package'
New-Item -ItemType Directory -Path $tempRoot | Out-Null

function Find-WindowsKitTool([string]$name) {
    $root = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (-not (Test-Path -LiteralPath $root)) { throw 'Windows SDK packaging tools are missing.' }
    $candidates = Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name -Descending
    foreach ($candidate in $candidates) {
        $path = Join-Path $candidate.FullName ('x64\' + $name)
        if (Test-Path -LiteralPath $path) { return $path }
    }
    throw "Windows SDK tool missing: $name"
}

function Invoke-Tool([string]$executable, [string[]]$arguments, [string]$failure) {
    & $executable @arguments
    if ($LASTEXITCODE -ne 0) { throw $failure }
}

try {
    $versionParts = @($Version.Split('.') | ForEach-Object { [int]$_ })
    if (@($versionParts | Where-Object { $_ -gt 65535 }).Count -ne 0) { throw 'MSIX version components must be 0–65535.' }
    if ($versionParts[3] -ne 0) { throw 'Use a new three-part Reel version for each release; the MSIX revision must be zero.' }
    foreach ($index in 0..3) {
        if ($Version.Split('.')[$index] -cne $versionParts[$index].ToString()) { throw 'MSIX version components cannot contain leading zeros.' }
    }
    $portableVersion = '{0}.{1}.{2}' -f $versionParts[0], $versionParts[1], $versionParts[2]
    $portableBuilder = Join-Path $PSScriptRoot 'build-portable.ps1'
    & $portableBuilder -ElectronDist $ElectronDist -GoogleDesktopClientId $GoogleDesktopClientId `
        -GoogleDesktopCredentialsFile $GoogleDesktopCredentialsFile -Version $portableVersion `
        -ExpectedArchitecture $Architecture -OutputZip $portableZip
    Expand-Archive -LiteralPath $portableZip -DestinationPath $packageRoot

    $manifestFile = Join-Path $packageRoot 'AppxManifest.xml'
    $assets = Join-Path $packageRoot 'Assets'
    New-Item -ItemType Directory -Path $assets | Out-Null
    Add-Type -AssemblyName System.Drawing
    foreach ($logo in @(
        @{ Name = 'Logo'; Source = 'web/icons/reel-512.png' },
        @{ Name = 'NotetakerLogo'; Source = 'web/icons/notetaker-512.png' }
    )) {
        $sourceLogo = [Drawing.Image]::FromFile((Join-Path $repo $logo.Source))
        try {
            foreach ($size in @(44, 150)) {
                $bitmap = [Drawing.Bitmap]::new($size, $size)
                try {
                    $graphics = [Drawing.Graphics]::FromImage($bitmap)
                    try {
                        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
                        $graphics.DrawImage($sourceLogo, 0, 0, $size, $size)
                    } finally { $graphics.Dispose() }
                    $bitmap.Save((Join-Path $assets "Square${size}x${size}$($logo.Name).png"), [Drawing.Imaging.ImageFormat]::Png)
                } finally { $bitmap.Dispose() }
            }
        } finally { $sourceLogo.Dispose() }
    }

    if ($Publisher -notmatch '^(CN|O|OU|L|S|ST|C|E|DC|SERIALNUMBER)=[^<>"\r\n]+(?:,\s*(CN|O|OU|L|S|ST|C|E|DC|SERIALNUMBER)=[^<>"\r\n]+)*$') {
        throw 'Publisher must be the signing certificate subject as a distinguished name.'
    }
    $escapedPublisher = [Security.SecurityElement]::Escape($Publisher)
    $identity = 'RocketShipHQ.Reel'
    $minOS = '10.0.19041.0'
    $arch = $Architecture
    $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="$identity" Publisher="$escapedPublisher" Version="$Version" ProcessorArchitecture="$arch" />
  <Properties>
    <DisplayName>Reel</DisplayName>
    <PublisherDisplayName>RocketShip HQ</PublisherDisplayName>
    <Logo>Assets\Square44x44Logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="$minOS" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="Recorder" Executable="ReelRecorderLauncher.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Reel Recorder" Description="Record your screen and share meetings with Reel."
          Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png"
          BackgroundColor="#FFFFFF" />
    </Application>
    <Application Id="Notetaker" Executable="ReelNotetakerLauncher.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Reel Notetaker" Description="Open Reel meeting notes."
          Square150x150Logo="Assets\Square150x150NotetakerLogo.png" Square44x44Logo="Assets\Square44x44NotetakerLogo.png"
          BackgroundColor="#FFFFFF" />
    </Application>
    <Application Id="Companion" Executable="Reel.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Reel Companion" Description="Meeting setup, capture and local recordings."
          Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png"
          BackgroundColor="#FFFFFF" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
    [IO.File]::WriteAllText($manifestFile, $manifest, (New-Object Text.UTF8Encoding($false)))

    $launcherSource = Join-Path $PSScriptRoot 'msix/Launcher.cs'
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework C# compiler is missing.' }
    $entryPoints = [ordered]@{}
    foreach ($name in @('ReelRecorderLauncher', 'ReelNotetakerLauncher')) {
        $launcherPath = Join-Path $packageRoot ($name + '.exe')
        Invoke-Tool $compiler @('/nologo', '/target:winexe', "/out:$launcherPath", $launcherSource) `
            'Could not compile the package launcher.'
        $entryPoints[$name] = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $buildInfoPath = Join-Path $packageRoot 'build-info.json'
    $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
    $buildInfo | Add-Member -NotePropertyName distribution -NotePropertyValue 'MSIX App Installer package (requires trusted release signing)' -Force
    $buildInfo | Add-Member -NotePropertyName msixVersion -NotePropertyValue $Version
    $buildInfo | Add-Member -NotePropertyName msixPublisher -NotePropertyValue $Publisher
    $buildInfo | Add-Member -NotePropertyName msixEntryPoints -NotePropertyValue $entryPoints
    $buildInfo | Add-Member -NotePropertyName msixManifestSha256 -NotePropertyValue (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($buildInfoPath, ($buildInfo | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))

    $makeAppx = Find-WindowsKitTool 'makeappx.exe'
    $output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputMsix)
    $feedOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputAppInstaller)
    if ([IO.Path]::GetExtension($output) -ne '.msix' -or [IO.Path]::GetExtension($feedOutput) -ne '.appinstaller') {
        throw 'Output paths must end in .msix and .appinstaller.'
    }
    if ((Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath $feedOutput)) { throw 'Refusing to overwrite release artifacts.' }
    New-Item -ItemType Directory -Force -Path (Split-Path $output -Parent), (Split-Path $feedOutput -Parent) | Out-Null
    Invoke-Tool $makeAppx @('pack', '/d', $packageRoot, '/p', $output, '/o') 'MakeAppx failed.'

    $feedUriText = [Security.SecurityElement]::Escape($AppInstallerUri.AbsoluteUri)
    $packageUriText = [Security.SecurityElement]::Escape($PackageUri.AbsoluteUri)
    $feed = @"
<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2021"
              Version="$Version" Uri="$feedUriText">
  <MainPackage Name="$identity" Publisher="$escapedPublisher" Version="$Version"
               ProcessorArchitecture="$arch" Uri="$packageUriText" />
  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="$UpdateCheckHours" ShowPrompt="false" />
  </UpdateSettings>
</AppInstaller>
"@
    [IO.File]::WriteAllText($feedOutput, $feed, (New-Object Text.UTF8Encoding($false)))
    Write-Output "Created unsigned Reel $Architecture MSIX $Version."
    Write-Output "Package: $output"
    Write-Output "App Installer feed: $feedOutput"
    Write-Output "SHA256 $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
