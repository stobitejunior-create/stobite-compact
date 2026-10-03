#!/bin/bash
# update compact — one command to ship a new version of Stobite Compact.
#
#   update compact                      # next patch version (v1.1.0 -> v1.1.1)
#   update compact "Added auto-tune"    # same, with your own description
#   update compact --minor "Big update" # v1.1.x -> v1.2.0
#
# It checks the code, commits and pushes everything, tags the new version,
# waits while GitHub builds the Mac DMG and the Windows installer, downloads
# both to ~/Downloads, and (optionally) installs the new Mac app.
set -euo pipefail

REPO="$HOME/Developer/Stobite Compact"
bold() { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m✗ %s\033[0m\n" "$*"; exit 1; }

cd "$REPO" || fail "Can't find $REPO"

bump=patch
if [[ "${1:-}" == "--minor" ]]; then bump=minor; shift; fi
if [[ "${1:-}" == "--major" ]]; then bump=major; shift; fi
msg="${*:-Update $(date '+%Y-%m-%d %H:%M')}"

# ---- tools
if ! command -v gh >/dev/null; then bold "Installing the GitHub tool (gh)…"; brew install gh; fi
gh auth status >/dev/null 2>&1 || { bold "Sign in to GitHub (choose HTTPS, then 'Login with a web browser')"; gh auth login; }

# ---- check the code before shipping anything
bold "1/6  Checking the code"
PY=".venv/bin/python"; [[ -x "$PY" ]] || PY="python3"
"$PY" -m py_compile run.py stobite/*.py || fail "A Python file has an error (see above). Nothing was pushed."
if command -v node >/dev/null; then
  for f in web/*.js; do node --check "$f" || fail "$f has an error (see above). Nothing was pushed."; done
fi
echo "   ✓ code looks good"

# ---- next version number
git fetch --tags --quiet origin || true
last=$(git tag --list 'v*' --sort=-v:refname | head -1); last=${last:-v1.0.0}
IFS=. read -r MA MI PA <<<"${last#v}"
case $bump in
  major) next="v$((MA + 1)).0.0" ;;
  minor) next="v$MA.$((MI + 1)).0" ;;
  *)     next="v$MA.$MI.$((PA + 1))" ;;
esac
bold "2/6  Releasing $next  (previous: $last)"

# ---- commit + push
git add -A
if git diff --cached --quiet; then
  echo "   no file changes — rebuilding the current code as $next"
else
  git commit -q -m "$msg" && echo "   ✓ committed: $msg"
fi
git push -q origin HEAD && echo "   ✓ pushed to GitHub"

# ---- tag -> starts the GitHub build
bold "3/6  Starting the Mac + Windows build on GitHub"
git tag -a "$next" -m "$msg"
git push -q origin "$next"
sha=$(git rev-parse HEAD)
run=""
for _ in $(seq 1 40); do
  run=$(gh run list --workflow build.yml --commit "$sha" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [[ -n "$run" ]] && break
  sleep 3
done
[[ -n "$run" ]] || fail "GitHub didn't start a build. Open the Actions tab on github.com to check."

bold "4/6  Building (about 3–5 minutes)…"
if ! gh run watch "$run" --exit-status --interval 15; then
  gh run view "$run" --log-failed | tail -60
  fail "The build failed (log above). Copy it to Claude to fix."
fi

# ---- download
bold "5/6  Downloading the installers"
dest="$HOME/Downloads/Stobite Compact $next"
mkdir -p "$dest"
for _ in $(seq 1 20); do
  gh release download "$next" --dir "$dest" --clobber 2>/dev/null && break
  sleep 5
done
ls "$dest"/*.dmg "$dest"/*Setup.exe >/dev/null 2>&1 || fail "Couldn't download the release files. They're on the GitHub Releases page."
echo "   ✓ Mac:     $dest/$(cd "$dest" && ls *.dmg)"
echo "   ✓ Windows: $dest/$(cd "$dest" && ls *Setup.exe)"

# ---- install on this Mac
bold "6/6  Install"
read -r -p "   Install the new version into Applications on this Mac? [Y/n] " ans
if [[ ! "$ans" =~ ^[Nn] ]]; then
  osascript -e 'quit app "Stobite Compact"' >/dev/null 2>&1 || true
  sleep 1
  mnt=$(hdiutil attach -nobrowse -readonly "$dest"/*.dmg | tail -1 | awk -F'\t' '{print $NF}')
  rm -rf "/Applications/Stobite Compact.app"
  cp -R "$mnt/Stobite Compact.app" /Applications/
  hdiutil detach "$mnt" -quiet
  xattr -dr com.apple.quarantine "/Applications/Stobite Compact.app" 2>/dev/null || true
  echo "   ✓ installed /Applications/Stobite Compact.app"
fi
open "$dest"
bold "Done: Stobite Compact $next is released. Copy the Setup.exe to the Windows PC to install it there."
