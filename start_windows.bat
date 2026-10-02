@echo off
REM Double-click to run from source on Windows (first run installs what it needs).
cd /d "%~dp0"
if not exist .venv ( py -3 -m venv .venv && .venv\Scripts\pip install -r requirements.txt )
.venv\Scripts\python run.py
