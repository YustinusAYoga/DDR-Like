#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ ! -d node_modules ]]; then
  echo "Dependencies are missing. Run ./setup.sh first." >&2
  exit 1
fi
if [[ ! -f public/models/pose_landmarker_lite.task ]]; then
  echo "Pose model missing: camera tracking requires a successful ./setup.sh. Audio and coach practice are still available." >&2
fi
exec npm start -- "$@"
