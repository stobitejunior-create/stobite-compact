#!/bin/bash
# Builds dist/Stobite Compact.app and dist/Stobite-Compact-mac.dmg
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt -r requirements-build.txt
.venv/bin/pyinstaller --noconfirm --log-level WARN "Stobite Compact.spec"

# disk image with the app + a shortcut to Applications (drag to install)
rm -rf dist/dmg dist/Stobite-Compact-mac.dmg
mkdir -p dist/dmg
cp -R "dist/Stobite Compact.app" dist/dmg/
ln -s /Applications dist/dmg/Applications
hdiutil create -volname "Stobite Compact" -srcfolder dist/dmg -ov -format UDZO dist/Stobite-Compact-mac.dmg >/dev/null
rm -rf dist/dmg build
# keep only the DMG: a loose .app here would show up in Spotlight/Launchpad next to the installed one
rm -rf "dist/Stobite Compact.app" "dist/Stobite Compact"
echo "Built: dist/Stobite-Compact-mac.dmg"
