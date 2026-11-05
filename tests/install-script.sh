#!/usr/bin/env bash
# Isolated curl|bash fixture. No network, desktop application or installation.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/alabaster-install-test.XXXXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/source" "$fixture/assets"
archive='Alabaster-Dawn-Setup-linux-arm64.tar.gz'
executable='Alabaster-Dawn-Setup.arm64'

cat > "$fixture/bin/uname" <<'SH'
#!/usr/bin/env bash
case $1 in -s) printf '%s\n' "${TEST_OS:-Linux}" ;; -m) printf '%s\n' "${TEST_ARCH:-aarch64}" ;; *) exit 2 ;; esac
SH
cat > "$fixture/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
destination=''
while [[ $# -gt 0 ]]; do
  if [[ $1 == --output ]]; then destination=$2; shift 2; else url=$1; shift; fi
done
printf '%s\n' "$url" >> "$TEST_CASE/downloads"
[[ $url == https://github.com/mrdidit/alabaster-arm64/releases/download/v0.5.2/* ]] || exit 91
[[ ${TEST_NETWORK_FAILURE:-0} == 0 ]] || exit 22
case ${url##*/} in
  SHA256SUMS) cp -- "$TEST_SUMS" "$destination" ;;
  Alabaster-Dawn-Setup-linux-arm64.tar.gz) cp -- "$TEST_ARCHIVE" "$destination" ;;
  *) exit 92 ;;
esac
SH
cat > "$fixture/source/$executable" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ $(readlink /proc/self/fd/0) == /dev/null ]] || exit 93
printf '%s\n' "$0" > "$TEST_CASE/gui"
exit "${TEST_GUI_STATUS:-0}"
SH
chmod 755 "$fixture/bin/"* "$fixture/source/$executable"
tar -czf "$fixture/assets/$archive" -C "$fixture/source" "$executable"
hash=$(sha256sum "$fixture/assets/$archive"); hash=${hash%% *}
printf '%s  %s\n' "$hash" "$archive" > "$fixture/assets/SHA256SUMS"
cp "$fixture/assets/$archive" "$fixture/assets/tampered.tar.gz"
printf 'tamper' >> "$fixture/assets/tampered.tar.gz"
printf '%064d  unrelated.tar.gz\n' 0 > "$fixture/assets/missing-sums"
cat "$fixture/assets/SHA256SUMS" "$fixture/assets/SHA256SUMS" > "$fixture/assets/duplicate-sums"
printf 'Unrelated file\n' > "$fixture/source/unrelated"
tar -czf "$fixture/assets/extra.tar.gz" -C "$fixture/source" "$executable" unrelated
hash=$(sha256sum "$fixture/assets/extra.tar.gz"); printf '%s  %s\n' "${hash%% *}" "$archive" > "$fixture/assets/extra-sums"
mkdir "$fixture/symlink"
ln -s ../source/unrelated "$fixture/symlink/$executable"
tar -czf "$fixture/assets/symlink.tar.gz" -C "$fixture/symlink" "$executable"
hash=$(sha256sum "$fixture/assets/symlink.tar.gz"); printf '%s  %s\n' "${hash%% *}" "$archive" > "$fixture/assets/symlink-sums"
mkdir "$fixture/invalid"
printf '#!/does/not/exist\n' > "$fixture/invalid/$executable"
tar -czf "$fixture/assets/invalid.tar.gz" -C "$fixture/invalid" "$executable"
hash=$(sha256sum "$fixture/assets/invalid.tar.gz"); printf '%s  %s\n' "${hash%% *}" "$archive" > "$fixture/assets/invalid-sums"
head -n -1 "$root/install.sh" > "$fixture/truncated.sh"

checks=0
run_case() {
  local label=$1 expected=$2 gui=$3 message=$4
  shift 4
  local directory="$fixture/$label" result=0
  mkdir -p "$directory/temp"
  if cat "${SCRIPT_UNDER_TEST:-$root/install.sh}" | env -u WAYLAND_DISPLAY \
    PATH="$fixture/bin:$PATH" DISPLAY=:fixture TMPDIR="$directory/temp" \
    TEST_CASE="$directory" TEST_ARCHIVE="$fixture/assets/$archive" TEST_SUMS="$fixture/assets/SHA256SUMS" \
    "$@" /bin/bash > "$directory/output" 2>&1; then result=0; else result=$?; fi
  if [[ $result != "$expected" ]]; then cat "$directory/output" >&2; printf 'FAIL %s: exit %s, expected %s\n' "$label" "$result" "$expected" >&2; exit 1; fi
  if [[ $gui == yes ]]; then [[ -f "$directory/gui" ]] || { cat "$directory/output" >&2; exit 1; }
  else [[ ! -e "$directory/gui" ]] || { printf 'FAIL %s unexpectedly launched setup\n' "$label" >&2; exit 1; }; fi
  if [[ -n $message ]]; then grep -F -- "$message" "$directory/output" >/dev/null || { cat "$directory/output" >&2; exit 1; }; fi
  local leftovers
  shopt -s nullglob dotglob
  leftovers=("$directory/temp/"*)
  [[ ${#leftovers[@]} == 0 ]] || { printf 'FAIL %s left temporary files\n' "$label" >&2; exit 1; }
  checks=$((checks+1))
  printf 'PASS %s\n' "$label"
}

run_case success 0 yes 'Opening setup'
run_case network 1 no 'Could not download' TEST_NETWORK_FAILURE=1
run_case checksum 1 no 'checksum mismatch' TEST_ARCHIVE="$fixture/assets/tampered.tar.gz"
run_case checksum-missing 1 no 'checksum for the setup archive is missing' TEST_SUMS="$fixture/assets/missing-sums"
run_case checksum-duplicate 1 no 'checksum list is invalid' TEST_SUMS="$fixture/assets/duplicate-sums"
run_case unexpected-member 1 no 'unexpected files' TEST_ARCHIVE="$fixture/assets/extra.tar.gz" TEST_SUMS="$fixture/assets/extra-sums"
run_case symlink-member 1 no 'regular executable' TEST_ARCHIVE="$fixture/assets/symlink.tar.gz" TEST_SUMS="$fixture/assets/symlink-sums"
run_case wrong-architecture 1 no 'ARM64 device' TEST_ARCH=x86_64
run_case wrong-os 1 no 'requires Linux' TEST_OS=Darwin
run_case no-display 1 no 'Desktop Mode' DISPLAY=
run_case gui-failure 7 yes 'status 7' TEST_GUI_STATUS=7
run_case gui-cancel 130 yes 'status 130' TEST_GUI_STATUS=130
run_case launch-failure 126 no 'status 126' TEST_ARCHIVE="$fixture/assets/invalid.tar.gz" TEST_SUMS="$fixture/assets/invalid-sums"
SCRIPT_UNDER_TEST="$fixture/truncated.sh" run_case truncated-download 0 no ''
[[ ! -e "$fixture/truncated-download/downloads" ]]
[[ ! -e "$fixture/wrong-architecture/downloads" && ! -e "$fixture/no-display/downloads" ]]
printf '%s isolated installer checks passed.\n' "$checks"
