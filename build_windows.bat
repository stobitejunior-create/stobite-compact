@echo off
REM Builds Stobite Compact for Windows on this PC (free: no GitHub minutes).
REM Needs Python 3.12 (python.org). With Inno Setup 6 installed (jrsoftware.org) it also makes the
REM installer, dist\Stobite-Compact-Setup.exe; without it you get the app folder dist\Stobite Compact.
cd /d "%~dp0"
if not exist .venv py -3 -m venv .venv
.venv\Scripts\pip install -r requirements.txt -r requirements-build.txt || goto :fail
.venv\Scripts\pyinstaller --noconfirm "Stobite Compact.spec" || goto :fail
set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if exist "%ISCC%" (
  "%ISCC%" installer\windows.iss || goto :fail
  echo Built: dist\Stobite-Compact-Setup.exe
) else (
  echo Built: dist\Stobite Compact\Stobite Compact.exe
  echo Install Inno Setup 6 to also get a Setup.exe installer.
)
pause
exit /b 0
:fail
echo The build failed - copy the messages above to Claude.
pause
exit /b 1
