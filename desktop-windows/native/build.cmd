@echo off
setlocal
set FRAMEWORK=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FRAMEWORK%\csc.exe" set FRAMEWORK=%WINDIR%\Microsoft.NET\FrameworkArm64\v4.0.30319
if not exist "%FRAMEWORK%\csc.exe" set FRAMEWORK=%WINDIR%\Microsoft.NET\Framework\v4.0.30319
set CSC=%FRAMEWORK%\csc.exe
if not exist "%CSC%" exit /b 2
set WPF=%FRAMEWORK%\WPF
if not exist "%WPF%\UIAutomationClient.dll" set WPF=%WINDIR%\Microsoft.NET\FrameworkArm64\v4.0.30319\WPF
if not exist "%WPF%\UIAutomationClient.dll" exit /b 2
cd /d "%~dp0"
"%CSC%" /nologo /target:exe /out:ReelNativeJoin.exe /r:"%WPF%\UIAutomationClient.dll" /r:"%WPF%\UIAutomationTypes.dll" /r:"%WPF%\WindowsBase.dll" /r:"%FRAMEWORK%\System.Web.Extensions.dll" /r:Microsoft.CSharp.dll Core.cs ClickSampling.cs WinJoin.cs OutlookCalendar.cs Program.cs
if errorlevel 1 exit /b 1
"%CSC%" /nologo /target:exe /out:ProcessIsolationTests.exe /r:"%WPF%\UIAutomationClient.dll" /r:"%WPF%\UIAutomationTypes.dll" /r:"%WPF%\WindowsBase.dll" Core.cs WinJoin.cs ProcessIsolationTests.cs
if errorlevel 1 exit /b 1
ProcessIsolationTests.exe
if errorlevel 1 exit /b 1
"%CSC%" /nologo /target:exe /out:PolicyTests.exe Core.cs PolicyTests.cs
if errorlevel 1 exit /b 1
PolicyTests.exe
if errorlevel 1 exit /b 1
"%CSC%" /nologo /define:TEST_FIXTURE /target:exe /out:FixturePolicyTests.exe Core.cs FixturePolicyTests.cs
if errorlevel 1 exit /b 1
FixturePolicyTests.exe
if errorlevel 1 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-media-trim.ps1" -Compiler "%CSC%"
if errorlevel 1 exit /b 1
exit /b 0
