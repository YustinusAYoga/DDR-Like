#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

for tool in node npm curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. Install Node.js 22.12+ (with npm) and curl, then retry." >&2
    exit 1
  fi
done
node --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    console.error("Node.js 22.12 or newer is required.");
    process.exit(1);
  }
'
npm run setup
echo "Setup complete. Run ./run.sh to start the dance studio."
