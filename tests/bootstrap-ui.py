#!/usr/bin/env python3
"""Compile the production bootstrap and check its isolated installer window."""
import argparse
import json
import os
import re
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--gui', action='store_true', help='Use a private Xvfb/Openbox display.')
args = parser.parse_args()


def stop(process):
    if process is None or process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)


with tempfile.TemporaryDirectory(prefix='alabaster-bootstrap-ui-') as folder:
    temp = Path(folder)
    binary = temp / 'bootstrap-ui-test'
    gtk = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gtk+-3.0'], text=True))
    subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                    str(ROOT / 'tests/bootstrap-ui-test.c'), *gtk, '-o', str(binary)], check=True, timeout=30)
    if not args.gui:
        subprocess.run([str(binary)], check=True, timeout=10)
    else:
        for tool in ['Xvfb', 'openbox', 'xprop', 'xwininfo']:
            if not shutil.which(tool):
                raise SystemExit(f'GUI check unavailable: {tool} is required.')
        read_fd, write_fd = os.pipe()
        display = window_manager = None
        try:
            with (temp / 'display.log').open('wb') as log:
                display = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0',
                                            '1280x720x24', '-nolisten', 'tcp'], pass_fds=(write_fd,),
                                           stdout=log, stderr=log, start_new_session=True)
            os.close(write_fd)
            if not select.select([read_fd], [], [], 8)[0]:
                raise RuntimeError('Private X display did not start within eight seconds.')
            number = os.read(read_fd, 64).decode().strip()
            os.close(read_fd)
            if not number.isdigit():
                with (temp / 'display.log').open('rb') as log:
                    log.seek(max(0, (temp / 'display.log').stat().st_size - 2000))
                    raise RuntimeError(log.read().decode(errors='replace'))
            env = os.environ.copy()
            for key in ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'WAYLAND_DISPLAY', 'MANGOHUD',
                        'FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'GTK_PATH', 'GTK_MODULES',
                        'GIO_EXTRA_MODULES', 'GIO_MODULE_DIR', 'DBUS_SESSION_BUS_ADDRESS']:
                env.pop(key, None)
            (temp / 'run').mkdir(mode=0o700)
            env.update(DISPLAY=':' + number, GDK_BACKEND='x11', GTK_CSD='0', NO_AT_BRIDGE='1', HOME=str(temp), XDG_CONFIG_HOME=str(temp / 'config'),
                       XDG_CACHE_HOME=str(temp / 'cache'), XDG_DATA_HOME=str(temp / 'data'),
                       XDG_RUNTIME_DIR=str(temp / 'run'))
            with (temp / 'window-manager.log').open('wb') as log:
                window_manager = subprocess.Popen(['openbox', '--sm-disable'], env=env,
                                                 stdout=log, stderr=log, start_new_session=True)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                result = subprocess.run(['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'], env=env,
                                        capture_output=True, text=True, timeout=2)
                match = re.search(r'window id # (0x[0-9a-f]+)', result.stdout)
                if result.returncode == 0 and match:
                    manager = subprocess.run(['xprop', '-id', match[1], '_NET_SUPPORTING_WM_CHECK', '_NET_WM_NAME'],
                                             env=env, capture_output=True, text=True, timeout=2)
                    if f'window id # {match[1]}' in manager.stdout and 'Openbox' in manager.stdout:
                        print(json.dumps({'private_window_manager': manager.stdout.strip(), 'display': env['DISPLAY']}), flush=True)
                        break
                time.sleep(.1)
            else:
                raise RuntimeError('Private window manager did not start within five seconds.')
            try:
                subprocess.run([str(binary), '--gui'], env=env, check=True, timeout=20)
            except Exception:
                with (temp / 'window-manager.log').open('rb') as log:
                    log.seek(max(0, (temp / 'window-manager.log').stat().st_size - 4000))
                    print('Private Openbox output:', log.read().decode(errors='replace'), flush=True)
                raise
            print(json.dumps({'scope': 'Production bootstrap functions; disposable process fixtures and private X display only.',
                              'real_installation_or_steam_changes': False}))
        finally:
            stop(window_manager)
            stop(display)
