#!/usr/bin/env bash
# Publish a FlightDeck release to GitHub Releases and make it visible to the
# in-app auto-updater.
#
#   ./installer/publish-release.sh owner/repo ["release notes"]
#
# What it does:
#   1. Builds the installer (./installer/build.sh) — version from package.json.
#   2. Computes the installer's SHA-256.
#   3. Writes latest.json {version, url, sha256, notes}.
#   4. Creates GitHub release v<version> with the installer + latest.json as assets.
#
# The app's update feed URL is then:
#   https://github.com/owner/repo/releases/latest/download/latest.json
# Paste it once in Settings -> App updates, or bake it into
# installer/update-feed.json before building so installs phone home automatically.
#
# Requires: gh (authenticated), ./installer/build.sh working.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="${1:?usage: publish-release.sh owner/repo [\"release notes\"]}"
VERSION="$(python3 -c "import json; print(json.load(open('package.json'))['version'])")"
NOTES="${2:-FlightDeck $VERSION}"

./installer/build.sh

EXE="$HOME/workspace/your_files/FlightDeck-Setup-$VERSION.exe"
[ -f "$EXE" ] || { echo "installer not found: $EXE"; exit 1; }
SHA="$(sha256sum "$EXE" | cut -d' ' -f1)"
TAG="v$VERSION"
DL="https://github.com/$REPO/releases/download/$TAG/FlightDeck-Setup-$VERSION.exe"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/latest.json" "$VERSION" "$DL" "$SHA" "$NOTES" <<'PYEOF'
import json, sys
_, path, version, url, sha, notes = sys.argv
json.dump({"version": version, "url": url, "sha256": sha, "notes": notes},
          open(path, "w"), indent=2)
print(open(path).read())
PYEOF

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "release $TAG exists — uploading assets to it"
  gh release upload "$TAG" --repo "$REPO" --clobber "$EXE" "$TMP/latest.json"
else
  gh release create "$TAG" --repo "$REPO" --title "FlightDeck $VERSION" \
    --notes "$NOTES" "$EXE" "$TMP/latest.json"
fi

echo
echo "Feed URL for the app:"
echo "  https://github.com/$REPO/releases/latest/download/latest.json"
