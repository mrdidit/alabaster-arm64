#!/usr/bin/env bash
# Download the verified release and open the same graphical setup application.
main() {
  set -euo pipefail
  local release='https://github.com/mrdidit/alabaster-arm64/releases/download/v0.5.2'
  local archive='Alabaster-Dawn-Setup-linux-arm64.tar.gz'
  local executable='Alabaster-Dawn-Setup.arm64'
  local temporary='' gui_pid='' status=0

  fail() { printf 'Alabaster: %s\n' "$*" >&2; exit 1; }
  cleanup() {
    if [[ -n "$gui_pid" ]]; then kill "$gui_pid" 2>/dev/null || true; fi
    if [[ -n "$temporary" ]]; then rm -rf -- "$temporary"; fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [[ $# == 0 ]] || fail 'No arguments are needed. Run this installer in Desktop Mode.'
  [[ $(uname -s) == Linux ]] || fail 'This installer requires Linux.'
  case $(uname -m) in aarch64|arm64) ;; *) fail 'This installer requires an ARM64 device.' ;; esac
  [[ $EUID != 0 ]] || fail 'Run this installer as your normal desktop user, without sudo.'
  [[ -n ${DISPLAY:-} || -n ${WAYLAND_DISPLAY:-} ]] || fail 'Open a terminal in Desktop Mode, then run the install command again.'
  local command
  for command in curl sha256sum tar mktemp chmod rm; do
    command -v "$command" >/dev/null || fail "Required command not found: $command"
  done

  umask 077
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/alabaster-setup.XXXXXXXX") || fail 'Could not create a temporary download directory.'
  printf 'Downloading Alabaster ARM64 setup v0.5.2…\n'
  local asset
  for asset in SHA256SUMS "$archive"; do
    curl --fail --show-error --location --progress-bar \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --connect-timeout 15 --max-time 600 --retry 2 \
      --output "$temporary/$asset" "$release/$asset" || fail "Could not download $asset. Retry the install command."
  done

  local expected='' digest='' name='' rest='' actual members details
  while read -r digest name rest || [[ -n $digest$name$rest ]]; do
    if [[ ${name#\*} == "$archive" ]]; then
      [[ $digest =~ ^[[:xdigit:]]{64}$ && -z $rest && -z $expected ]] || fail 'The release checksum list is invalid.'
      expected=${digest,,}
    fi
  done < "$temporary/SHA256SUMS"
  [[ -n $expected ]] || fail 'The release checksum for the setup archive is missing.'
  actual=$(sha256sum "$temporary/$archive") || fail 'Could not verify the setup archive.'
  [[ ${actual%% *} == "$expected" ]] || fail 'Setup checksum mismatch. Nothing was installed; retry the download.'

  members=$(tar -tzf "$temporary/$archive") || fail 'The setup archive could not be read.'
  [[ $members == "$executable" ]] || fail 'The setup archive contains unexpected files.'
  details=$(tar -tvzf "$temporary/$archive") || fail 'The setup archive could not be inspected.'
  [[ $details == -* ]] || fail 'The setup archive does not contain a regular executable.'
  tar -xOzf "$temporary/$archive" -- "$executable" > "$temporary/$executable" || fail 'Could not extract the setup application.'
  chmod 700 "$temporary/$executable" || fail 'Could not prepare the setup application.'

  printf 'Opening setup…\n'
  "$temporary/$executable" </dev/null &
  gui_pid=$!
  if wait "$gui_pid"; then status=0; else status=$?; fi
  gui_pid=''
  if [[ $status != 0 ]]; then printf 'Alabaster: Setup exited with status %s.\n' "$status" >&2; fi
  exit "$status"
}

main "$@"
