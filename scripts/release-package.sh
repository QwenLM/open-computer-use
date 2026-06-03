#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${repo_root}/dist"
release_dir="${dist_dir}/release"
staging_dir="${release_dir}/npm-staging"
tarball_dir="${release_dir}/npm"

rm -rf "${release_dir}"
mkdir -p "${tarball_dir}"

node "${repo_root}/scripts/npm/build-packages.mjs" \
  --configuration release \
  --arch universal \
  --out-dir "${staging_dir}"

# Locate staged packages by their package.json rather than assuming a fixed
# directory depth. Scoped packages (e.g. @qwen-code/open-computer-use) live one
# level deeper than unscoped ones, so a `-maxdepth 1 -type d` scan would stop at
# the `@qwen-code` scope directory (which has no package.json) and `npm pack`
# would ENOENT. Matching package.json files handles both layouts.
while IFS= read -r package_json; do
  package_dir="$(dirname "${package_json}")"
  npm pack "${package_dir}" --pack-destination "${tarball_dir}" >/dev/null
done < <(find "${staging_dir}" -mindepth 1 -name package.json -type f -not -path '*/node_modules/*' | sort)

python3 - "${release_dir}/release-manifest.json" "${repo_root}" "${tarball_dir}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

manifest_path = Path(sys.argv[1])
repo_root = Path(sys.argv[2])
tarball_dir = Path(sys.argv[3])

artifacts = []
for tarball in sorted(tarball_dir.glob("*.tgz")):
    artifacts.append({
        "name": tarball.name,
        "size_bytes": tarball.stat().st_size,
    })

manifest = {
    "repository": os.environ.get("GITHUB_REPOSITORY", "local"),
    "git_sha": os.environ.get("GITHUB_SHA") or __import__("subprocess").check_output(
        ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
        text=True,
    ).strip(),
    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "artifacts": artifacts,
    "distribution": {
        "type": "npm",
        "package_count": len(artifacts),
        "staging_dir": str(tarball_dir.relative_to(repo_root)),
    },
}

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

echo "${release_dir}"
