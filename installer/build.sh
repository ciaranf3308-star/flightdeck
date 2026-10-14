#!/usr/bin/env bash
# FlightDeck Windows installer build.
#   1. vbslint  — build-time VBScript validation (fails before packaging)
#   2. stage.sh — compile + assemble the installer bundle
#   3. makensis — build FlightDeck-Setup-<version>.exe
#
# Version comes from the root package.json. Usage: ./installer/build.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOOLS_DIR="$HOME/workspace/.build-tools"
NODE_EXE_DEFAULT="$TOOLS_DIR/winnode/x/node-v22.23.3-win-x64/node.exe"

VERSION="$(python3 -c "import json; print(json.load(open('package.json'))['version'])")"
echo "== FlightDeck installer build v$VERSION =="

echo "== 1/3 vbslint =="
python3 installer/vbslint.py installer/launch.vbs installer/stop.vbs

echo "== 2/3 stage =="
if [ ! -f "${NODE_EXE:-$NODE_EXE_DEFAULT}" ]; then
  echo "Missing portable node.exe."
  echo "Download it once with:"
  echo "  mkdir -p $TOOLS_DIR/winnode && cd $TOOLS_DIR/winnode && \\"
  echo "    curl -sL -o node-win.zip https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip && \\"
  echo "    unzip -o -q node-win.zip \"node-v22.23.3-win-x64/node.exe\" -d x"
  echo "Or set NODE_EXE=/path/to/node.exe"
  exit 1
fi
NODE_EXE="${NODE_EXE:-$NODE_EXE_DEFAULT}" ./installer/stage.sh

echo "== 3/3 makensis =="
export NSISDIR="${NSISDIR:-$TOOLS_DIR/nsis/root/usr/share/nsis}"
MAKENSIS="${MAKENSIS:-$TOOLS_DIR/nsis/root/usr/bin/makensis}"
if [ ! -x "$MAKENSIS" ]; then
  echo "makensis not found at $MAKENSIS"
  echo "On Debian/Ubuntu: sudo apt-get install nsis nsis-common"
  echo "Or extract the .debs from http://ftp.debian.org/debian/pool/main/n/nsis/ into $TOOLS_DIR/nsis/root"
  exit 1
fi
"$MAKENSIS" -DVERSION="$VERSION" installer/flightdeck.nsi

OUT="$HOME/workspace/your_files/FlightDeck-Setup-$VERSION.exe"
ls -la "$OUT"
echo "== done: $OUT =="
