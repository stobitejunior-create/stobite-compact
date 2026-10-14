#!/bin/bash
# Builds dist/Stobite-Compact-mac-<Apple-Silicon|Intel>.dmg on this Mac, no GitHub needed.
#   ./build_mac.sh          # for the kind of Mac it runs on
#   ./build_mac.sh intel    # an Intel build on an Apple silicon Mac (runs under Rosetta)
# (Apple silicon and Intel need separate builds: numpy, scipy and pedalboard are compiled per chip.)
set -e
cd "$(dirname "$0")"
want="${1:-}"
if [[ "$want" == "intel" && "$(uname -m)" == "arm64" ]]; then
  CHIP="Intel"
  RUN="arch -x86_64"
  VENV=.venv-intel
  # Xcode's Python is universal (Intel + Apple silicon), so it can run as Intel under Rosetta
  BASE=/Applications/Xcode.app/Contents/Developer/usr/bin/python3
  [[ -x "$BASE" ]] || BASE=/usr/bin/python3
  [ -d "$VENV" ] || $RUN "$BASE" -m venv "$VENV"
else
  case "$(uname -m)" in
    arm64) CHIP="Apple-Silicon" ;;
    *)     CHIP="Intel" ;;
  esac
  RUN=""
  VENV=.venv
  [ -d "$VENV" ] || python3 -m venv "$VENV"
fi
DMG="dist/Stobite-Compact-mac-$CHIP.dmg"
$RUN "$VENV/bin/python" -m pip install -q -r requirements.txt -r requirements-build.txt
$RUN "$VENV/bin/pyinstaller" --noconfirm --log-level WARN --workpath "build/$CHIP" --distpath "dist/$CHIP" "Stobite Compact.spec"

# disk image with the app + a shortcut to Applications (drag to install)
rm -rf "dist/dmg-$CHIP" "$DMG"
mkdir -p "dist/dmg-$CHIP"
cp -R "dist/$CHIP/Stobite Compact.app" "dist/dmg-$CHIP/"
ln -s /Applications "dist/dmg-$CHIP/Applications"
hdiutil create -volname "Stobite Compact" -srcfolder "dist/dmg-$CHIP" -ov -format UDZO "$DMG" >/dev/null
# keep only the DMG: a loose .app here would show up in Spotlight/Launchpad next to the installed one
rm -rf "dist/dmg-$CHIP" "build/$CHIP" "dist/$CHIP"
echo "Built: $DMG"
