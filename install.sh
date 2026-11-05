#!/usr/bin/env bash
# Download the verified release and open the same graphical setup application.
main() {
  set -euo pipefail
  local release='https://github.com/mrdidit/alabaster-arm64/releases/download/v0.5.2'
  local archive='Alabaster-Dawn-Setup-linux-arm64.tar.gz'
  local executable='Alabaster-Dawn-Setup.arm64'
  local temporary='' gui_pid='' status=0

  fail() { printf 'Alabaster: %s\n' "$*" >&2; exit 1; }
  discover_desktop() {
    # Read the login user's desktop environment, never another account's session.
    # NUL-delimited values are data: no sourcing or evaluation of shell expressions.
    command -v pgrep >/dev/null || fail 'Desktop discovery needs pgrep. Run from a desktop terminal instead.'
    local pid entry key value signature selected_signature='' display_number
    local -a keys=(DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
                   XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP)
    local -A candidate=() selected=()
    while read -r pid; do
      [[ $pid =~ ^[0-9]+$ && -O /proc/$pid && -r /proc/$pid/environ ]] || continue
      candidate=()
      while IFS= read -r -d '' entry; do
        key=${entry%%=*}
        case $key in
          DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP)
            candidate[$key]=${entry#*=} ;;
        esac
      done < /proc/"$pid"/environ 2>/dev/null || continue
      # NW.js needs X11/Xwayland, even when setup uses native Wayland.
      [[ ${candidate[DISPLAY]:-} =~ ^(:|unix:)([0-9]+)(\.[0-9]+)?$ ]] || continue
      display_number=${BASH_REMATCH[2]}
      [[ -S /tmp/.X11-unix/X$display_number ]] || continue
      [[ -z ${candidate[XAUTHORITY]:-} || -r ${candidate[XAUTHORITY]} ]] || continue
      [[ -z ${candidate[XDG_RUNTIME_DIR]:-} || ( -d ${candidate[XDG_RUNTIME_DIR]} && -O ${candidate[XDG_RUNTIME_DIR]} ) ]] || continue
      if [[ -n ${candidate[WAYLAND_DISPLAY]:-} ]]; then
        value=${candidate[WAYLAND_DISPLAY]}
        [[ $value == /* ]] || value=${candidate[XDG_RUNTIME_DIR]:-}/$value
        [[ -S $value && -O $value ]] || continue
      fi
      signature=''
      for key in "${keys[@]}"; do signature+=$(printf '%q|' "${candidate[$key]:-}"); done
      [[ -z $selected_signature || $signature == "$selected_signature" ]] ||
        fail 'More than one desktop session was found. Run the command in the intended desktop terminal.'
      selected_signature=$signature
      for key in "${keys[@]}"; do selected[$key]=${candidate[$key]:-}; done
    done < <(pgrep -u "$EUID" -x 'plasmashell|gnome-shell|xfce4-session|cinnamon|mate-session|lxqt-session|sway|Hyprland|weston|enlightenment' || true)
    [[ -n ${selected[DISPLAY]:-} ]] ||
      fail 'No usable desktop session was found for this account. Sign into Desktop Mode on the device, then retry; if detection is unavailable, run from its desktop terminal.'
    for key in "${keys[@]}"; do
      unset "$key"
      [[ -z ${selected[$key]} ]] || export "$key=${selected[$key]}"
    done
    printf 'Desktop session found; setup will open on the device. Keep this terminal connected until setup closes.\n'
  }
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
  if [[ -z ${DISPLAY:-} && -z ${WAYLAND_DISPLAY:-} ]]; then discover_desktop; fi
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
