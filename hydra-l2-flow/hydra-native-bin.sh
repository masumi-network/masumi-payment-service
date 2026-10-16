# shellcheck shell=bash
# Native hydra-node binary: download, sha256 pinning, and the verified-install
# record. Sourced by hydra-native.sh, which sets the pins, NATIVE_BIN, BIN_DIR
# and the c_* helpers before sourcing this file. Not meant to run on its own.


# Resolve the commit a release tag points at, for the CI-artifact fallback
# below. Hydra's release tags are annotated, so the ref's object is a tag
# object one hop away from the actual commit; fall back to the ref's own sha
# if that second hop fails (a lightweight tag, or an API shape change).
resolve_tag_commit(){
  local tag="$1" ref_sha commit_sha
  ref_sha="$(gh api "repos/cardano-scaling/hydra/git/refs/tags/${tag}" --jq '.object.sha' 2>/dev/null)" || return 1
  commit_sha="$(gh api "repos/cardano-scaling/hydra/git/tags/${ref_sha}" --jq '.object.sha' 2>/dev/null)"
  echo "${commit_sha:-$ref_sha}"
}

# An installed binary cannot be checked against the upstream pin later:
# repair_dylibs may rewrite it in place (install_name_tool + ad-hoc codesign).
# So each verified install writes a sidecar, $NATIVE_BIN.sha256, with two
# lines: the pin that approved the install, and the sha256 of the final file.
# A binary is trusted only if it matches its sidecar AND the sidecar's pin is
# one this run is configured with. A binary with no sidecar (installed before
# this check existed, or dropped in by hand) is not trusted.
BIN_RECORD="${NATIVE_BIN}.sha256"

# Pins and recorded hashes are compared lowercased. Each must be exactly 64
# hex chars: `shasum -c` picks the algorithm from the digest length and
# ignores -a, so a 40-char value would silently be checked as SHA-1.
# Tests the raw value: a $(...) wrapper would strip trailing newlines first.
is_sha256(){ [[ "$1" =~ ^[0-9a-fA-F]{64}$ ]]; }
lower(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

configured_pins(){
  if [ -n "$HYDRA_BIN_TAG" ]; then
    lower "$HYDRA_BIN_TAG_SHA256"; echo
  else
    lower "$HYDRA_BINARY_SHA256"; echo
    lower "$HYDRA_RELEASE_SHA256"; echo
  fi
}

# Atomic write (temp file + mv), so a reader never sees a half-written record.
record_bin(){
  local pin sum
  pin="$(lower "$1")"
  sum="$(shasum -a 256 "$NATIVE_BIN" | cut -d' ' -f1)" || return 1
  is_sha256 "$pin" && is_sha256 "$sum" || return 1
  local tmp_record; tmp_record="$(mktemp "$BIN_RECORD.XXXXXX")" || return 1
  printf '%s\n%s\n' "$pin" "$sum" > "$tmp_record" && mv -f "$tmp_record" "$BIN_RECORD"
}

# Quiet check: returns 0 only for a binary that passes the rule above.
bin_is_verified(){
  [ -x "$NATIVE_BIN" ] && [ -f "$BIN_RECORD" ] || return 1
  local pin sum
  { read -r pin && read -r sum; } < "$BIN_RECORD" || return 1
  pin="$(lower "$pin")"; sum="$(lower "$sum")"
  is_sha256 "$pin" && is_sha256 "$sum" || return 1
  # Not `configured_pins | grep -q`: grep -q exits on the first match, the
  # next write gets SIGPIPE, and pipefail turns that match into a failure.
  local pins; pins="$(configured_pins)"
  grep -qxF "$pin" <<<"$pins" || return 1
  printf '%s  %s\n' "$sum" "$NATIVE_BIN" | shasum -a 256 -c - >/dev/null 2>&1
}

refuse_unverified(){
  c_red "refusing to run $NATIVE_BIN: it does not match a pinned, verified install"
  c_red "  (no $BIN_RECORD, a changed file, or a pin that differs from this run's)"
  c_red "  Remove it and its .sha256 record, then re-run to download and verify it again."
  exit 1
}

ensure_bin(){
  if [ -e "$NATIVE_BIN" ]; then
    bin_is_verified || refuse_unverified
    # repair_dylibs is normally a no-op after the first install. Re-record
    # only when it did change the file, which was verified one step above.
    local pin sum
    { read -r pin && read -r sum; } < "$BIN_RECORD"
    repair_dylibs
    if [ "$(shasum -a 256 "$NATIVE_BIN" | cut -d' ' -f1)" != "$(lower "$sum")" ]; then
      record_bin "$pin" || { c_red "could not record $BIN_RECORD"; exit 1; }
    fi
    return 0
  fi
  command -v gh >/dev/null 2>&1 || { c_red "missing: gh (needed to download the native binary)"; exit 1; }
  local tmp approved_pin=''; tmp="$(mktemp -d)"
  if [ -n "$HYDRA_BIN_TAG" ]; then
    # Same rule as the release paths: no pinned digest, no install. Checked
    # before the download so a missing pin fails at once.
    [ -n "$HYDRA_BIN_TAG_SHA256" ] || {
      c_red "HYDRA_BIN_TAG_SHA256 is required with HYDRA_BIN_TAG (sha256 of the extracted hydra-node)"
      exit 1
    }
    is_sha256 "$HYDRA_BIN_TAG_SHA256" || { c_red "HYDRA_BIN_TAG_SHA256 must be a 64-hex sha256"; exit 1; }
    c_blu "Downloading native $HYDRA_BIN_ARTIFACT (CI artifact, ~176 MiB)…"
    gh run download "$HYDRA_BIN_RUN_ID" --repo cardano-scaling/hydra \
      --name "$HYDRA_BIN_ARTIFACT" --dir "$tmp" || { c_red "download failed"; exit 1; }
    [ -f "$tmp/hydra-node" ] || { c_red "artifact missing hydra-node"; exit 1; }
    printf '%s  %s\n' "$HYDRA_BIN_TAG_SHA256" "$tmp/hydra-node" \
      | shasum -a 256 -c - || { c_red "checksum verification failed"; exit 1; }
    approved_pin="$HYDRA_BIN_TAG_SHA256"
  else
    # Tagged releases published a release-zip asset through 2.3.0. 2.4.0 and
    # 2.4.1 publish none at all (`gh release view <tag> --repo
    # cardano-scaling/hydra --json assets` returns `[]` for both, verified
    # for 2.4.1 — see docs/hydra-2.4.1-upgrade-runbook.md). Try the release
    # asset first regardless, since upstream could resume attaching one to a
    # future tag, and only fall back to a CI artifact — the same mechanism
    # HYDRA_BIN_TAG uses above — when there genuinely is none: resolve the
    # commit the tag points at, and pull the aarch64-darwin artifact from
    # that commit's own "Binaries" workflow run (for 2.4.1, commit
    # 099f5dd775d8640047d0074edef294c1b39a600d, run 33660882209 — verified,
    # see docs/hydra-2.4.1-upgrade-runbook.md).
    # A set but malformed pin fails before any download. A missing one is
    # checked per path below, since only the probe shows which path applies.
    local pin_var
    for pin_var in HYDRA_RELEASE_SHA256 HYDRA_BINARY_SHA256; do
      [ -z "${!pin_var}" ] || is_sha256 "${!pin_var}" \
        || { c_red "$pin_var must be a 64-hex sha256"; exit 1; }
    done
    c_blu "Checking for a hydra-aarch64-darwin-${HYDRA_VERSION}.zip release asset…"
    if gh release download "$HYDRA_VERSION" --repo cardano-scaling/hydra \
      --pattern "hydra-aarch64-darwin-${HYDRA_VERSION}.zip" --dir "$tmp" 2>/dev/null; then
      c_grn "  release asset path: found one — downloading (~176 MiB)…"
      # Dev's supply-chain check, kept as a hard requirement: a zip with no
      # pinned digest is not installed.
      [ -n "$HYDRA_RELEASE_SHA256" ] || {
        c_red "HYDRA_RELEASE_SHA256 is required for the ${HYDRA_VERSION} release zip"
        exit 1
      }
      is_sha256 "$HYDRA_RELEASE_SHA256" || { c_red "HYDRA_RELEASE_SHA256 must be a 64-hex sha256"; exit 1; }
      printf '%s  %s\n' "$HYDRA_RELEASE_SHA256" "$tmp/hydra-aarch64-darwin-${HYDRA_VERSION}.zip" \
        | shasum -a 256 -c - || { c_red "checksum verification failed"; exit 1; }
      (cd "$tmp" && unzip -oq "hydra-aarch64-darwin-${HYDRA_VERSION}.zip") || { c_red "unzip failed"; exit 1; }
      approved_pin="$HYDRA_RELEASE_SHA256"
    else
      c_blu "  release asset path: none published for ${HYDRA_VERSION} — falling back to the tag's CI artifact"
      local commit_sha run_id artifact="hydra-aarch64-darwin-${HYDRA_VERSION}"
      commit_sha="$(resolve_tag_commit "$HYDRA_VERSION")"
      [ -n "$commit_sha" ] || { c_red "could not resolve the commit tag $HYDRA_VERSION points at"; exit 1; }
      run_id="$(gh run list --repo cardano-scaling/hydra --commit "$commit_sha" \
        --workflow Binaries --json databaseId --jq '.[0].databaseId' 2>/dev/null)"
      # jq prints the literal string "null" for `.[0]` on an empty array,
      # which is non-empty and would otherwise sail through `[ -n ... ]`.
      [ -n "$run_id" ] && [ "$run_id" != "null" ] || { c_red "no Binaries CI run found for commit $commit_sha"; exit 1; }
      # No upstream checksum exists for a CI artifact, so the extracted binary
      # itself is pinned (see HYDRA_BINARY_SHA256 at the top of this file).
      # Checked before the 176 MiB download, so a missing pin fails at once.
      [ -n "$HYDRA_BINARY_SHA256" ] || {
        c_red "HYDRA_BINARY_SHA256 is required for the ${HYDRA_VERSION} CI artifact (no release zip to verify)"
        exit 1
      }
      is_sha256 "$HYDRA_BINARY_SHA256" || { c_red "HYDRA_BINARY_SHA256 must be a 64-hex sha256"; exit 1; }
      c_blu "  CI-artifact path: downloading $artifact from run $run_id (commit ${commit_sha:0:12}, ~176 MiB)…"
      gh run download "$run_id" --repo cardano-scaling/hydra \
        --name "$artifact" --dir "$tmp" || { c_red "download failed"; exit 1; }
      [ -f "$tmp/hydra-node" ] || { c_red "artifact missing hydra-node"; exit 1; }
      printf '%s  %s\n' "$HYDRA_BINARY_SHA256" "$tmp/hydra-node" \
        | shasum -a 256 -c - || { c_red "checksum verification failed"; exit 1; }
      approved_pin="$HYDRA_BINARY_SHA256"
    fi
  fi
  [ -f "$tmp/hydra-node" ] || { c_red "artifact missing hydra-node"; exit 1; }
  # Only the verified hydra-node is installed. hydra-tui ships unpinned in the
  # same artifact and nothing here uses it, so it is not installed.
  [ -n "$approved_pin" ] || { c_red "internal: no pin approved this install"; exit 1; }
  # The record attests whatever sits at $NATIVE_BIN, so confirm the installed
  # bytes are the verified ones (a failed or partial install must not be
  # recorded) before repair_dylibs and record_bin run.
  local src_sum; src_sum="$(shasum -a 256 "$tmp/hydra-node" | cut -d' ' -f1)"
  install -m 0755 "$tmp/hydra-node" "$NATIVE_BIN" || { c_red "install failed"; exit 1; }
  printf '%s  %s\n' "$src_sum" "$NATIVE_BIN" | shasum -a 256 -c - >/dev/null 2>&1 \
    || { c_red "installed $NATIVE_BIN does not match the verified download"; exit 1; }
  rm -rf "$tmp"
  repair_dylibs
  record_bin "$approved_pin" || { c_red "could not record $BIN_RECORD"; exit 1; }
  c_grn "  installed -> $NATIVE_BIN ($("$NATIVE_BIN" --version 2>/dev/null | head -1))"
}

repair_dylibs(){
  command -v otool >/dev/null 2>&1 || return 0
  command -v install_name_tool >/dev/null 2>&1 || return 0
  local nix_iconv
  nix_iconv="$(otool -L "$NATIVE_BIN" 2>/dev/null | awk '/\/nix\/store\/.*libiconv.*libiconv\.2\.dylib/ {print $1; exit}')"
  [ -n "$nix_iconv" ] || return 0
  install_name_tool -change "$nix_iconv" /usr/lib/libiconv.2.dylib "$NATIVE_BIN" || return 1
  command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$NATIVE_BIN" >/dev/null 2>&1
}
