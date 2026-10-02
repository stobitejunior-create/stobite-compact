#!/bin/bash
# Double-click to run from source on a Mac (first run installs what it needs).
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
exec .venv/bin/python run.py
