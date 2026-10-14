#!/usr/bin/env bash
# Assemble the Windows installer staging tree:
#   installer/staging/FlightDeck/
#     resources/node/node.exe          (portable Node.js, Windows x64)
#     resources/api/dist/              (compiled planning API)
#     resources/api/node_modules/      (zod + workspace packages, real copies)
#     resources/api/public/            (built desktop SPA, served by the API)
#     resources/bridge/                (optional user-built SimConnect bridge)
#     launch.vbs                       (hidden launcher)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/installer/staging/FlightDeck"
TOOLS_DIR="$HOME/workspace/.build-tools"
NODE_EXE="${NODE_EXE:-$TOOLS_DIR/winnode/x/node-v22.23.3-win-x64/node.exe}"

echo "== building packages =="
cd "$ROOT"
for p in packages/*/ services/planning-api; do
  (cd "$p" && npx tsc -p tsconfig.json)
done
(cd apps/desktop && npx vite build >/dev/null 2>&1)

echo "== staging to $STAGE =="
rm -rf "$STAGE"
mkdir -p "$STAGE/resources/node" "$STAGE/resources/api/node_modules/@flightdeck" "$STAGE/resources/bridge"

cp "$NODE_EXE" "$STAGE/resources/node/node.exe"
cp -r services/planning-api/dist "$STAGE/resources/api/dist"
# Stamp the bundle's version from the root package.json (installer version).
python3 - "$ROOT/package.json" "$ROOT/services/planning-api/package.json" "$STAGE/resources/api/package.json" <<'PYEOF'
import json, sys
root_ver = json.load(open(sys.argv[1]))["version"]
d = json.load(open(sys.argv[2]))
d["version"] = root_ver
json.dump(d, open(sys.argv[3], "w"), indent=2)
print("bundle version:", root_ver)
PYEOF
cp -r apps/desktop/dist/. "$STAGE/resources/api/public/"
cp -r node_modules/zod "$STAGE/resources/api/node_modules/zod"
cp -r node_modules/fast-xml-parser "$STAGE/resources/api/node_modules/fast-xml-parser"
cp -r node_modules/strnum "$STAGE/resources/api/node_modules/strnum"
for pkg in aircraft-adapters flight-providers msfs-export navigation route-engine shared-models; do
  dest="$STAGE/resources/api/node_modules/@flightdeck/$pkg"
  mkdir -p "$dest"
  cp "packages/$pkg/package.json" "$dest/"
  cp -r "packages/$pkg/dist" "$dest/dist"
done
# navigation data needed at runtime
mkdir -p "$STAGE/resources/api/node_modules/@flightdeck/navigation/dist/data"
cp packages/navigation/src/data/*.json "$STAGE/resources/api/node_modules/@flightdeck/navigation/dist/data/" 2>/dev/null || true
cp "$ROOT/installer/launch.vbs" "$STAGE/launch.vbs"
cp "$ROOT/installer/stop.vbs" "$STAGE/stop.vbs"
cp "$ROOT/installer/flightdeck.ico" "$STAGE/flightdeck.ico"
cp "$ROOT/installer/update-feed.json" "$STAGE/resources/api/update-feed.json"
# Fixture snapshots back the offline "fixtures" provider (used when no
# FlightAware key is set). Without these, every Flight Plan lookup in the
# packaged app returns state "empty".
cp -r "$ROOT/tests/fixtures" "$STAGE/resources/api/fixtures"
cat > "$STAGE/resources/bridge/README.txt" <<'EOF'
Optional: SimConnect bridge (built on Windows)
=============================================
Build it on your Windows PC with the .NET 8 SDK:

  cd services/simconnect-bridge
  dotnet publish -c Release -r win-x64 --self-contained false -o publish

Then copy publish/FlightDeck.SimConnectBridge.exe here.
FlightDeck's API starts it automatically (hidden) and stops it on Quit.
Without it, Live Telemetry simply reports disconnected.
EOF

echo "== staging tree =="
find "$STAGE" -maxdepth 3 | sort | head -30
du -sh "$STAGE"
