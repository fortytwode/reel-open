param([Parameter(Mandatory = $true)][string]$Compiler)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$native = Split-Path -Parent $MyInvocation.MyCommand.Path
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\UnionMetadata'
$runtimeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETCore\v4.5\System.Runtime.WindowsRuntime.dll'),
    (Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETCore\v4.5.2\System.Runtime.WindowsRuntime.dll'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Runtime.WindowsRuntime.dll'),
    (Join-Path $env:WINDIR 'Microsoft.NET\FrameworkArm64\v4.0.30319\System.Runtime.WindowsRuntime.dll'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\System.Runtime.WindowsRuntime.dll')
)
$runtimeRef = $runtimeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw 'The .NET Framework C# compiler is unavailable.' }
if (-not $runtimeRef) { throw 'The Windows SDK or .NET Framework installation lacks System.Runtime.WindowsRuntime.dll.' }
$sdk = Get-ChildItem -LiteralPath $kits -Directory -ErrorAction Stop |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'Windows.winmd') -PathType Leaf) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Install a Windows 10 SDK with Windows.winmd to build the Windows media helper.' }
$winmd = Join-Path $sdk.FullName 'Windows.winmd'
$common = @('/nologo', '/platform:anycpu', "/r:$winmd", "/r:$runtimeRef")
Push-Location $native
try {
    & $Compiler @common '/target:exe' '/out:ReelMediaTrim.exe' 'MediaTrim.cs' 'MediaTrimProgram.cs'
    if ($LASTEXITCODE -ne 0) { throw 'Windows media helper compilation failed.' }
    & $Compiler @common '/target:exe' '/out:ReelMediaTrimTests.exe' 'MediaTrim.cs' 'MediaTrimTests.cs'
    if ($LASTEXITCODE -ne 0) { throw 'Windows media trim test compilation failed.' }
    & (Join-Path $native 'ReelMediaTrimTests.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Windows media trim export smoke failed.' }
} finally { Pop-Location }
