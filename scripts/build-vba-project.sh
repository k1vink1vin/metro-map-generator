#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VBA_SOURCE="$ROOT_DIR/vba/TransferGroups.vb"
OUTPUT_DIR="$ROOT_DIR/public/examples"
TMP_DIR="${RUNNER_TEMP:-/tmp}/metro-map-vba-build"
COMPILER_DIR="$TMP_DIR/vbamc"
COMPILER_COMMIT="769a94f820e9baf1a2a6fb186ad9b1e242d5ed3b"

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR/out" "$OUTPUT_DIR"

git clone --quiet https://github.com/NetOfficeFw/vbamc.git "$COMPILER_DIR"
git -C "$COMPILER_DIR" checkout --quiet "$COMPILER_COMMIT"

dotnet build   "$COMPILER_DIR/src/vbamc/vbamc.csproj"   -c Release   -f net8.0   --nologo

dotnet   "$COMPILER_DIR/src/vbamc/bin/Release/net8.0/vbamc.dll"   -m "$VBA_SOURCE"   -f "macro-container.xlsm"   -o "$TMP_DIR/out"   -n "MetroMapGenerator"   --company "Metro Map Generator"

unzip -p   "$TMP_DIR/out/macro-container.xlsm"   xl/vbaProject.bin   > "$OUTPUT_DIR/vbaProject.bin"

if [[ ! -s "$OUTPUT_DIR/vbaProject.bin" ]]; then
  echo "vbaProject.bin was not generated." >&2
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
path = Path("public/examples/vbaProject.bin")
print(f"Embedded VBA project generated: {path} ({path.stat().st_size} bytes)")
PY
