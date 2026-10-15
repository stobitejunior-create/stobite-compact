#!/bin/bash
# rebuild-compact — one command to ship a new version of Stobite Compact.
#
#   rebuild-compact                        # next patch version (v1.1.0 -> v1.1.1), Mac builds only
#   rebuild-compact "Added auto-tune"      # same, with your own description
#   rebuild-compact --minor "Big update"   # v1.1.x -> v1.2.0
#   rebuild-compact --windows "..."        # also build the Windows installer on GitHub (uses Actions minutes)
#   rebuild-compact --windows-only         # just build Windows for the latest version (no new version)
#   rebuild-compact --no-intel "..."       # skip the Intel Mac build (quicker)
#
# The Mac DMGs (Apple silicon + Intel) are built here on this Mac, so a normal release uses no
# GitHub Actions minutes. GitHub only builds the Windows installer when you ask with --windows,
# or build it for free on the Windows PC with build_windows.bat.
set -euo pipefail

REPO="$HOME/Developer/Stobite Compact"
bold() { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m✗ %s\033[0m\n" "$*"; exit 1; }

cd "$REPO" || fail "Can't find $REPO"

bump=patch; windows=0; intel=1; only_windows=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --minor) bump=minor ;;
    --major) bump=major ;;
    --windows) windows=1 ;;
    --windows-only) only_windows=1 ;;
    --no-intel) intel=0 ;;
    *) fail "Unknown option $1" ;;
  esac
  shift
done
msg="${*:-Update $(date '+%Y-%m-%d %H:%M')}"

# ---- tools
if ! command -v gh >/dev/null; then bold "Installing the GitHub tool (gh)…"; brew install gh; fi
gh auth status >/dev/null 2>&1 || { bold "Sign in to GitHub (choose HTTPS, then 'Login with a web browser')"; gh auth login; }

windows_build() {   # $1 = tag. Builds only Windows on GitHub and attaches it to that release.
  local tag="$1"
  bold "Building the Windows installer on GitHub for $tag (about 5 minutes, uses Actions minutes)"
  local before
  before=$(gh run list --workflow build.yml --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  gh workflow run build.yml -f tag="$tag" -f mac=false
  local run=""
  for _ in $(seq 1 40); do
    run=$(gh run list --workflow build.yml --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    [[ -n "$run" && "$run" != "$before" ]] && break
    run=""; sleep 3
  done
  [[ -n "$run" ]] || fail "GitHub didn't start the Windows build. Open the Actions tab on github.com to check."
  if ! gh run watch "$run" --exit-status --interval 20; then
    gh run view "$run" --log-failed | tail -60
    fail "The Windows build failed (log above). Copy it to Claude to fix."
  fi
  local dest="$HOME/Downloads/Stobite Compact $tag"
  mkdir -p "$dest"
  gh release download "$tag" --pattern "*Setup.exe" --dir "$dest" --clobber
  echo "   ✓ Windows: $dest/$(cd "$dest" && ls *Setup.exe)"
}

if [[ $only_windows == 1 ]]; then
  git fetch --tags --quiet origin || true
  last=$(git tag --list 'v*' --sort=-v:refname | head -1)
  [[ -n "$last" ]] || fail "No version released yet."
  windows_build "$last"
  open "$HOME/Downloads/Stobite Compact $last"
  exit 0
fi

# ---- check the code before shipping anything
bold "1/5  Checking the code"
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
bold "2/5  Releasing $next  (previous: $last)"

# ---- build the Macs here first: if a build fails, nothing has been pushed
bold "3/5  Building the Mac apps on this Mac (a few minutes)"
rm -f dist/*.dmg
./build_mac.sh || fail "The Apple silicon build failed (see above). Nothing was pushed."
if [[ $intel == 1 && "$(uname -m)" == "arm64" ]]; then
  ./build_mac.sh intel || fail "The Intel build failed (see above). Nothing was pushed. Try: rebuild-compact --no-intel"
fi

# ---- commit + push + tag (a tag no longer starts any GitHub build)
git add -A
if git diff --cached --quiet; then
  echo "   no file changes — releasing the current code as $next"
else
  git commit -q -m "$msg" && echo "   ✓ committed: $msg"
fi
git push -q origin HEAD && echo "   ✓ pushed to GitHub"
git tag -a "$next" -m "$msg"
git push -q origin "$next"

# ---- publish the release with the Mac files (uploading uses no Actions minutes)
bold "4/5  Publishing $next on GitHub"
gh release create "$next" dist/*.dmg --title "Stobite Compact $next" --notes "$msg" >/dev/null
echo "   ✓ release published"
dest="$HOME/Downloads/Stobite Compact $next"
mkdir -p "$dest"
cp dist/*.dmg "$dest/"
for f in "$dest"/*.dmg; do
  case "$f" in *Intel*) echo "   ✓ Mac (Intel):          $f" ;; *) echo "   ✓ Mac (Apple silicon):  $f" ;; esac
done

if [[ $windows == 1 ]]; then
  windows_build "$next"
else
  echo "   Windows: not built (saves GitHub minutes). Build it on the Windows PC with build_windows.bat,"
  echo "            or here with:  rebuild-compact --windows-only"
fi

# ---- install on this Mac
bold "5/5  Install"
read -r -p "   Install the new version into Applications on this Mac? [Y/n] " ans
if [[ ! "$ans" =~ ^[Nn] ]]; then
  osascript -e 'quit app "Stobite Compact"' >/dev/null 2>&1 || true
  sleep 1
  if [[ "$(uname -m)" == "arm64" ]]; then mine=$(ls "$dest"/*Apple-Silicon*.dmg 2>/dev/null | head -1); else mine=$(ls "$dest"/*Intel*.dmg 2>/dev/null | head -1); fi
  [[ -n "$mine" ]] || mine=$(ls "$dest"/*.dmg | head -1)
  mnt=$(hdiutil attach -nobrowse -readonly "$mine" | tail -1 | awk -F'\t' '{print $NF}')
  rm -rf "/Applications/Stobite Compact.app"
  cp -R "$mnt/Stobite Compact.app" /Applications/
  hdiutil detach "$mnt" -quiet
  xattr -dr com.apple.quarantine "/Applications/Stobite Compact.app" 2>/dev/null || true
  echo "   ✓ installed /Applications/Stobite Compact.app"
fi
rm -f dist/*.dmg
open "$dest"
bold "Done: Stobite Compact $next is released."
