#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
configuration="debug"
arch_mode="native"
codesign_mode="${OPEN_COMPUTER_USE_CODESIGN_MODE:-auto}"
codesign_identity="${OPEN_COMPUTER_USE_CODESIGN_IDENTITY:-}"
codesign_keychain="${OPEN_COMPUTER_USE_CODESIGN_KEYCHAIN:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/build-open-computer-use-app.sh [debug|release] [--configuration debug|release] [--arch native|arm64|x86_64|universal]

Examples:
  ./scripts/build-open-computer-use-app.sh debug
  ./scripts/build-open-computer-use-app.sh --configuration release --arch universal

Environment:
  OPEN_COMPUTER_USE_CODESIGN_MODE=auto|identity|adhoc|none
  OPEN_COMPUTER_USE_CODESIGN_IDENTITY="Developer ID Application: Example, Inc. (TEAMID)"
  OPEN_COMPUTER_USE_CODESIGN_KEYCHAIN=/path/to/signing.keychain-db
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    debug|release)
      configuration="$1"
      shift
      ;;
    --configuration)
      configuration="${2:-}"
      if [[ -z "${configuration}" ]]; then
        echo "--configuration requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --arch)
      arch_mode="${2:-}"
      if [[ -z "${arch_mode}" ]]; then
        echo "--arch requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${configuration}" != "debug" && "${configuration}" != "release" ]]; then
  echo "Unsupported configuration: ${configuration}" >&2
  exit 1
fi

if [[ "${arch_mode}" != "native" && "${arch_mode}" != "arm64" && "${arch_mode}" != "x86_64" && "${arch_mode}" != "universal" ]]; then
  echo "Unsupported arch mode: ${arch_mode}" >&2
  exit 1
fi

if [[ "${codesign_mode}" != "auto" && "${codesign_mode}" != "identity" && "${codesign_mode}" != "adhoc" && "${codesign_mode}" != "none" ]]; then
  echo "Unsupported OPEN_COMPUTER_USE_CODESIGN_MODE: ${codesign_mode}" >&2
  exit 1
fi

read_package_version() {
  node -e "console.log(require('${repo_root}/package.json').version)"
}

build_binary() {
  local triple="${1:-}"
  local scratch_path="${2:-}"
  local -a args=(-c "${configuration}")

  if [[ -n "${triple}" ]]; then
    args+=(--triple "${triple}")
  fi

  if [[ -n "${scratch_path}" ]]; then
    args+=(--scratch-path "${scratch_path}")
  fi

  local binary_dir
  binary_dir="$(swift build "${args[@]}" --show-bin-path)"
  swift build "${args[@]}" --product OpenComputerUse >&2
  printf '%s/OpenComputerUse\n' "${binary_dir}"
}

find_codesign_identity() {
  local prefix="${1:-}"
  local -a args=(find-identity -v -p codesigning)

  if [[ -n "${codesign_keychain}" ]]; then
    args+=("${codesign_keychain}")
  fi

  security "${args[@]}" 2>/dev/null \
    | sed -n "s/.*\"\\(${prefix}: .*\\)\"/\1/p" \
    | head -n 1
}

list_user_keychains() {
  security list-keychains -d user \
    | sed -n 's/^[[:space:]]*"\(.*\)"$/\1/p'
}

run_with_codesign_keychain() {
  local keychain_path="${1:-}"
  shift

  if [[ -z "${keychain_path}" ]]; then
    "$@"
    return
  fi

  local -a existing_keychains=()
  while IFS= read -r keychain; do
    if [[ -n "${keychain}" ]]; then
      existing_keychains+=("${keychain}")
    fi
  done < <(list_user_keychains)

  local -a desired_keychains=("${keychain_path}")
  local existing=""
  for existing in "${existing_keychains[@]}"; do
    if [[ "${existing}" != "${keychain_path}" ]]; then
      desired_keychains+=("${existing}")
    fi
  done

  security list-keychains -d user -s "${desired_keychains[@]}" >/dev/null

  local status=0
  "$@" || status=$?

  if [[ ${#existing_keychains[@]} -gt 0 ]]; then
    security list-keychains -d user -s "${existing_keychains[@]}" >/dev/null
  else
    security list-keychains -d user -s >/dev/null
  fi

  return "${status}"
}

resolve_codesign_identity() {
  case "${codesign_mode}" in
    none)
      return 1
      ;;
    adhoc)
      printf '%s\n' "-"
      return 0
      ;;
    identity)
      if [[ -z "${codesign_identity}" ]]; then
        echo "OPEN_COMPUTER_USE_CODESIGN_IDENTITY is required when OPEN_COMPUTER_USE_CODESIGN_MODE=identity" >&2
        exit 1
      fi
      printf '%s\n' "${codesign_identity}"
      return 0
      ;;
    auto)
      if [[ -n "${codesign_identity}" ]]; then
        printf '%s\n' "${codesign_identity}"
        return 0
      fi

      local discovered_identity
      discovered_identity="$(find_codesign_identity "Developer ID Application")"
      if [[ -n "${discovered_identity}" ]]; then
        printf '%s\n' "${discovered_identity}"
        return 0
      fi

      discovered_identity="$(find_codesign_identity "Apple Development")"
      if [[ -n "${discovered_identity}" ]]; then
        printf '%s\n' "${discovered_identity}"
        return 0
      fi

      printf '%s\n' "-"
      return 0
      ;;
  esac
}

# Records the identity used by the most recent codesign_app_bundle call so
# notarize_app_bundle can decide whether the bundle is eligible (Developer ID
# only — ad-hoc "-" and the skipped "none" mode are not notarizable). Empty
# means "not signed".
CODESIGN_RESULT_IDENTITY=""

codesign_app_bundle() {
  local app_path="${1:-}"
  local identity=""
  CODESIGN_RESULT_IDENTITY=""

  if ! identity="$(resolve_codesign_identity)"; then
    echo "Skipping codesign for ${app_path} (OPEN_COMPUTER_USE_CODESIGN_MODE=none)" >&2
    return
  fi

  local -a args=(--force --deep --sign "${identity}")

  if [[ -n "${codesign_keychain}" && "${identity}" != "-" ]]; then
    args+=(--keychain "${codesign_keychain}")
  fi

  if [[ "${identity}" != "-" ]]; then
    args+=(--options runtime)
  fi

  run_with_codesign_keychain "${codesign_keychain}" \
    codesign "${args[@]}" "${app_path}" >/dev/null

  CODESIGN_RESULT_IDENTITY="${identity}"

  if [[ "${identity}" == "-" ]]; then
    echo "Signed ${app_path} with ad-hoc identity; macOS TCC may still treat separately built copies as different app identities until a stable Apple signing identity is configured." >&2
  else
    echo "Signed ${app_path} with ${identity}" >&2
  fi
}

# Submit a Developer ID-signed .app to Apple's notary service and staple the
# resulting ticket into the bundle, so the copy bundled into the npm tarball is
# self-contained (Gatekeeper accepts it offline).
#
# Opt-in via OPEN_COMPUTER_USE_NOTARIZE=1 — notarization is a slow Apple
# round-trip and must never run during local dev or smoke builds. Gated on App
# Store Connect API key credentials (same secrets the Cursor Motion DMG uses).
# Skips gracefully (never fails the build) when the flag is off, credentials are
# missing, or the bundle is only ad-hoc signed.
notarize_app_bundle() {
  local app_path="${1:-}"

  local notarize_flag="${OPEN_COMPUTER_USE_NOTARIZE:-0}"
  case "${notarize_flag}" in
    1 | true | yes | on) ;;
    *) return 0 ;;
  esac

  if [[ -z "${CODESIGN_RESULT_IDENTITY}" || "${CODESIGN_RESULT_IDENTITY}" == "-" ]]; then
    echo "Skipping notarization for ${app_path}: requires a Developer ID signature (got '${CODESIGN_RESULT_IDENTITY:-unsigned}')." >&2
    return 0
  fi

  local p8_base64="${APPLE_NOTARY_API_KEY_P8_BASE64:-}"
  local key_id="${APPLE_NOTARY_KEY_ID:-}"
  local issuer_id="${APPLE_NOTARY_ISSUER_ID:-}"
  local team_id="${APPLE_DEVELOPER_TEAM_ID:-}"

  if [[ -z "${p8_base64}" || -z "${key_id}" || -z "${issuer_id}" || -z "${team_id}" ]]; then
    echo "Skipping notarization for ${app_path}: APPLE_NOTARY_* credentials not fully configured." >&2
    return 0
  fi

  local work_dir
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/open-computer-use-notarize.XXXXXX")"
  local api_key_path="${work_dir}/AuthKey_${key_id}.p8"
  local zip_path="${work_dir}/app-to-notarize.zip"

  P8_BASE64="${p8_base64}" API_KEY_PATH="${api_key_path}" python3 -c 'import base64, os, pathlib; pathlib.Path(os.environ["API_KEY_PATH"]).write_bytes(base64.b64decode(os.environ["P8_BASE64"]))'

  # notarytool needs a container (zip/dmg/pkg); ditto --keepParent preserves the
  # .app bundle structure inside the zip.
  /usr/bin/ditto -c -k --keepParent "${app_path}" "${zip_path}"

  echo "Submitting ${app_path} to Apple notary service (this can take a few minutes)..." >&2
  xcrun notarytool submit "${zip_path}" \
    --key "${api_key_path}" \
    --key-id "${key_id}" \
    --issuer "${issuer_id}" \
    --team-id "${team_id}" \
    --wait

  # Staple the ticket into the .app itself so the tarballed copy validates offline.
  xcrun stapler staple "${app_path}"
  xcrun stapler validate "${app_path}"

  rm -rf "${work_dir}"
  echo "Notarized + stapled ${app_path}" >&2
}

cd "${repo_root}"

package_version="$(read_package_version)"
bundle_version="${OPEN_COMPUTER_USE_BUNDLE_VERSION:-$(git -C "${repo_root}" rev-list --count HEAD 2>/dev/null || echo 1)}"
release_app_bundle_name="Open Computer Use.app"
development_app_bundle_name="Open Computer Use (Dev).app"
legacy_app_bundle_name="OpenComputerUse.app"
bundle_icon_name="OpenComputerUse.icns"
icon_master_png="${repo_root}/assets/app-icons/open-computer-use-1024.png"
iconset_build_script="${repo_root}/scripts/build-apple-iconset.sh"
cursor_reference_source="${repo_root}/docs/references/codex-computer-use-reverse-engineering/assets/extracted-2026-04-19/official-software-cursor-window-252.png"

bundle_display_name="Open Computer Use"
bundle_identifier="com.qwenlm.opencomputeruse"
app_variant="release"
app_bundle_name="${release_app_bundle_name}"

if [[ "${configuration}" != "release" ]]; then
  bundle_display_name="Open Computer Use (Dev)"
  bundle_identifier="com.qwenlm.opencomputeruse.dev"
  app_variant="dev"
  app_bundle_name="${development_app_bundle_name}"
fi

app_root="${repo_root}/dist/${app_bundle_name}"
release_app_root="${repo_root}/dist/${release_app_bundle_name}"
development_app_root="${repo_root}/dist/${development_app_bundle_name}"
legacy_app_root="${repo_root}/dist/${legacy_app_bundle_name}"
contents_dir="${app_root}/Contents"
macos_dir="${contents_dir}/MacOS"
resources_dir="${contents_dir}/Resources"

rm -rf "${app_root}" "${legacy_app_root}"
if [[ "${app_variant}" == "release" ]]; then
  rm -rf "${development_app_root}"
else
  rm -rf "${release_app_root}"
fi
mkdir -p "${macos_dir}" "${resources_dir}"

case "${arch_mode}" in
  native)
    cp "$(build_binary "" "")" "${macos_dir}/OpenComputerUse"
    ;;
  arm64)
    cp "$(build_binary "arm64-apple-macosx14.0" ".build/arm64-${configuration}")" "${macos_dir}/OpenComputerUse"
    ;;
  x86_64)
    cp "$(build_binary "x86_64-apple-macosx14.0" ".build/x86_64-${configuration}")" "${macos_dir}/OpenComputerUse"
    ;;
  universal)
    arm_binary="$(build_binary "arm64-apple-macosx14.0" ".build/arm64-${configuration}")"
    x86_binary="$(build_binary "x86_64-apple-macosx14.0" ".build/x86_64-${configuration}")"
    lipo -create -output "${macos_dir}/OpenComputerUse" "${arm_binary}" "${x86_binary}"
    ;;
esac

chmod +x "${macos_dir}/OpenComputerUse"

if [[ ! -f "${icon_master_png}" ]]; then
  echo "Missing icon master PNG: ${icon_master_png}" >&2
  exit 1
fi

if [[ ! -f "${iconset_build_script}" ]]; then
  echo "Missing iconset build script: ${iconset_build_script}" >&2
  exit 1
fi

if [[ ! -f "${cursor_reference_source}" ]]; then
  echo "Missing cursor reference PNG: ${cursor_reference_source}" >&2
  exit 1
fi

icon_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/open-computer-use-icon.XXXXXX")"
cleanup() {
  if [[ -n "${icon_work_dir:-}" ]]; then
    rm -rf "${icon_work_dir}"
  fi
}
trap cleanup EXIT
iconset_dir="${icon_work_dir}/OpenComputerUse.iconset"
mkdir -p "${iconset_dir}"
"${iconset_build_script}" "${icon_master_png}" "${iconset_dir}"
iconutil -c icns "${iconset_dir}" -o "${resources_dir}/${bundle_icon_name}"
cp "${cursor_reference_source}" "${resources_dir}/official-software-cursor-window-252.png"

cat > "${contents_dir}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>OpenComputerUse</string>
  <key>CFBundleIconFile</key>
  <string>${bundle_icon_name}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundle_identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${bundle_display_name}</string>
  <key>CFBundleDisplayName</key>
  <string>${bundle_display_name}</string>
  <key>OpenComputerUseAppVariant</key>
  <string>${app_variant}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${package_version}</string>
  <key>CFBundleVersion</key>
  <string>${bundle_version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

plutil -lint "${contents_dir}/Info.plist" >/dev/null
codesign_app_bundle "${app_root}"
notarize_app_bundle "${app_root}"

echo "Built ${app_root} (${arch_mode}, ${configuration})"
