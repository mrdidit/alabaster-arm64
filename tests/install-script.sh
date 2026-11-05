#!/usr/bin/env bash
# Isolated curl|bash fixture. No network, desktop application or installation.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/alabaster-install-test.XXXXXXXX")
desktop_pids=()
cleanup() {
  local pid
  for pid in "${desktop_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${desktop_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf -- "$fixture"
}
trap cleanup EXIT
mkdir -p "$fixture/bin" "$fixture/source" "$fixture/assets"
archive='Alabaster-Dawn-Setup-linux-arm64.tar.gz'
executable='Alabaster-Dawn-Setup.arm64'

cat > "$fixture/bin/uname" <<'SH'
#!/usr/bin/env bash
case $1 in -s) printf '%s\n' "${TEST_OS:-Linux}" ;; -m) printf '%s\n' "${TEST_ARCH:-aarch64}" ;; *) exit 2 ;; esac
SH
cat > "$fixture/bin/pgrep" <<'SH'
#!/usr/bin/env bash
[[ $1 == -u && $2 == "$EUID" && $3 == -x ]] || exit 94
printf 'discovery\n' >> "$TEST_CASE/discovery"
[[ -n ${TEST_DESKTOP_PIDS:-} ]] || exit 1
printf '%s\n' "$TEST_DESKTOP_PIDS"
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
[[ -z ${TEST_EXPECT_DISPLAY+x} || ${DISPLAY:-} == "$TEST_EXPECT_DISPLAY" ]] || exit 95
[[ -z ${TEST_EXPECT_AUTH+x} || ${XAUTHORITY:-} == "$TEST_EXPECT_AUTH" ]] || exit 96
[[ -z ${TEST_EXPECT_RUNTIME+x} || ${XDG_RUNTIME_DIR:-} == "$TEST_EXPECT_RUNTIME" ]] || exit 97
[[ -z ${TEST_EXPECT_WAYLAND+x} || ${WAYLAND_DISPLAY:-} == "$TEST_EXPECT_WAYLAND" ]] || exit 98
[[ -z ${DESKTOP_UNLISTED+x} && -z ${BASH_ENV+x} ]] || exit 99
[[ $PATH == "$TEST_EXPECT_PATH" ]] || exit 100
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
  if (cd "$directory"; cat "${SCRIPT_UNDER_TEST:-$root/install.sh}" | env -u WAYLAND_DISPLAY -u BASH_ENV -u DESKTOP_UNLISTED \
    PATH="$fixture/bin:$PATH" DISPLAY=:fixture TMPDIR="$directory/temp" \
    TEST_CASE="$directory" TEST_ARCHIVE="$fixture/assets/$archive" TEST_SUMS="$fixture/assets/SHA256SUMS" \
    TEST_EXPECT_PATH="$fixture/bin:$PATH" TEST_DESKTOP_PIDS= \
    "$@" /bin/bash) > "$directory/output" 2>&1; then result=0; else result=$?; fi
  if [[ $result != "$expected" ]]; then cat "$directory/output" >&2; printf 'FAIL %s: exit %s, expected %s\n' "$label" "$result" "$expected" >&2; exit 1; fi
  if [[ $gui == yes ]]; then [[ -f "$directory/gui" ]] || { cat "$directory/output" >&2; exit 1; }
  else [[ ! -e "$directory/gui" ]] || { printf 'FAIL %s unexpectedly launched setup\n' "$label" >&2; exit 1; }; fi
  if [[ -n $message ]]; then grep -F -- "$message" "$directory/output" >/dev/null || { cat "$directory/output" >&2; exit 1; }; fi
  local leftovers
  shopt -s nullglob dotglob
  leftovers=("$directory/temp/"*)
  [[ ${#leftovers[@]} == 0 ]] || { printf 'FAIL %s left temporary files\n' "$label" >&2; exit 1; }
  [[ ! -e "$directory/EVALUATED" && ! -e "$directory/ALSO" && ! -e "$directory/unlisted-evaluated" ]]
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

# Same-UID /proc environments and private Unix sockets. No real desktop PID is
# ever returned by the mocked pgrep, and no real display receives a connection.
cat > "$fixture/desktop.py" <<'PY'
import os, pathlib, signal, socket, sys
number, runtime, ready, mode = sys.argv[1:]
opened = []
paths = []
def stop(*_):
    raise SystemExit
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGALRM, stop)
signal.alarm(30)
try:
    targets = []
    if mode != 'missing-x':
        targets.append('/tmp/.X11-unix/X' + number)
    if mode != 'missing-wayland':
        targets.append(str(pathlib.Path(runtime) / 'wayland-fixture'))
    for name in targets:
        connection = socket.socket(socket.AF_UNIX)
        connection.bind(name)
        paths.append(name)
        opened.append(connection)
        connection.listen(1)
    pathlib.Path(ready).write_text(str(os.getpid()))
    while True:
        signal.pause()
finally:
    for connection in opened:
        connection.close()
    for name in paths:
        pathlib.Path(name).unlink(missing_ok=True)
PY
authority="$fixture/"'authority $(touch EVALUATED) `touch ALSO` ; literal'
: > "$authority"
printf 'printf leaked > "$TEST_CASE/unlisted-evaluated"\n' > "$fixture/unsafe-bashenv"
desktop_index=0
start_desktop() {
  local label=$1 mode=${2:-valid}
  desktop_index=$((desktop_index+1))
  desktop_number=$((1000000+$$*10+desktop_index))
  desktop_runtime="$fixture/runtime-$label"
  mkdir -m 700 "$desktop_runtime"
  desktop_display=":$desktop_number"
  [[ $mode != wayland-only ]] || desktop_display=''
  env DISPLAY="$desktop_display" WAYLAND_DISPLAY=wayland-fixture XAUTHORITY="$authority" \
    XDG_RUNTIME_DIR="$desktop_runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$desktop_runtime/bus" \
    XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=plasma \
    DESKTOP_UNLISTED=must-not-import BASH_ENV="$fixture/unsafe-bashenv" PATH=/not-imported \
    /usr/bin/python3 "$fixture/desktop.py" "$desktop_number" "$desktop_runtime" "$desktop_runtime/ready" "$mode" \
    > "$desktop_runtime/log" 2>&1 &
  desktop_pid=$!
  desktop_pids+=("$desktop_pid")
  local attempt
  for attempt in {1..100}; do
    [[ ! -f "$desktop_runtime/ready" ]] || return 0
    kill -0 "$desktop_pid" 2>/dev/null || break
    sleep 0.02
  done
  cat "$desktop_runtime/log" >&2
  printf 'Desktop fixture did not become ready.\n' >&2
  exit 1
}

start_desktop primary
primary_pid=$desktop_pid primary_display=$desktop_display primary_runtime=$desktop_runtime
run_case ssh-discovery 0 yes 'Desktop session found' DISPLAY= TEST_DESKTOP_PIDS="$primary_pid" \
  TEST_EXPECT_DISPLAY="$primary_display" TEST_EXPECT_AUTH="$authority" TEST_EXPECT_RUNTIME="$primary_runtime" TEST_EXPECT_WAYLAND=wayland-fixture
run_case explicit-display 0 yes 'Opening setup' DISPLAY=:explicit XAUTHORITY=original-authority \
  TEST_DESKTOP_PIDS="$primary_pid" TEST_EXPECT_DISPLAY=:explicit TEST_EXPECT_AUTH=original-authority
[[ ! -e "$fixture/explicit-display/discovery" ]]
(exit 0) & dead_pid=$!
wait "$dead_pid"
run_case dead-desktop-process 1 no 'No usable desktop session' DISPLAY= TEST_DESKTOP_PIDS="$dead_pid"
start_desktop missing-x missing-x
run_case missing-x11-socket 1 no 'No usable desktop session' DISPLAY= TEST_DESKTOP_PIDS="$desktop_pid"
start_desktop wayland-only wayland-only
run_case wayland-only-session 1 no 'No usable desktop session' DISPLAY= TEST_DESKTOP_PIDS="$desktop_pid"
start_desktop missing-wayland missing-wayland
run_case missing-wayland-socket 1 no 'No usable desktop session' DISPLAY= TEST_DESKTOP_PIDS="$desktop_pid"
start_desktop second
run_case ambiguous-desktops 1 no 'More than one desktop session' DISPLAY= TEST_DESKTOP_PIDS="$primary_pid"$'\n'"$desktop_pid"
printf '%s isolated installer checks passed.\n' "$checks"
