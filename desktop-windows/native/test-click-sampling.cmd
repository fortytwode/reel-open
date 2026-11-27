@echo off
setlocal
set FRAMEWORK=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FRAMEWORK%\csc.exe" set FRAMEWORK=%WINDIR%\Microsoft.NET\FrameworkArm64\v4.0.30319
if not exist "%FRAMEWORK%\csc.exe" set FRAMEWORK=%WINDIR%\Microsoft.NET\Framework\v4.0.30319
set CSC=%FRAMEWORK%\csc.exe
if not exist "%CSC%" exit /b 2
cd /d "%~dp0"
"%CSC%" /nologo /target:exe /out:ClickSamplingTests.exe /r:"%FRAMEWORK%\System.Windows.Forms.dll" /r:"%FRAMEWORK%\System.Drawing.dll" ClickSampling.cs ClickSamplingTests.cs
if errorlevel 1 exit /b 1
ClickSamplingTests.exe
if errorlevel 1 exit /b 1
exit /b 0
