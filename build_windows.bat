@echo off
REM Builds dist\Stobite Compact\Stobite Compact.exe  (run on a Windows PC with Python 3.12 installed)
cd /d "%~dp0"
if not exist .venv py -3 -m venv .venv
.venv\Scripts\pip install -r requirements.txt -r requirements-build.txt
.venv\Scripts\pyinstaller --noconfirm "Stobite Compact.spec"
echo Built: dist\Stobite Compact\Stobite Compact.exe
pause
