#!/bin/bash
# Builds dist/Stobite-Compact-mac-<Apple-Silicon|Intel>.dmg for the kind of Mac it runs on.
# (Apple silicon and Intel need separate builds: numpy, scipy and pedalboard are compiled per chip.)
set -e
cd "$(dirname "$0")"
case "$(uname -m)" in
  arm64) CHIP="Apple-Silicon" ;;
  *)     CHIP="Intel" ;;
esac
DMG="dist/Stobite-Compact-mac-$CHIP.dmg"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt -r requirements-build.txt
.venv/bin/pyinstaller --noconfirm --log-level WARN "Stobite Compact.spec"

# disk image with the app + a shortcut to Applications (drag to install)
rm -rf dist/dmg "$DMG"
mkdir -p dist/dmg
cp -R "dist/Stobite Compact.app" dist/dmg/
ln -s /Applications dist/dmg/Applications
hdiutil create -volname "Stobite Compact" -srcfolder dist/dmg -ov -format UDZO "$DMG" >/dev/null
rm -rf dist/dmg build
# keep only the DMG: a loose .app here would show up in Spotlight/Launchpad next to the installed one
rm -rf "dist/Stobite Compact.app" "dist/Stobite Compact"
echo "Built: $DMG ($(uname -m))"
