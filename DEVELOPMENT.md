# Development

## Tested on KPFE

The full game runs on KPFE (Snapdragon 8 Elite) with native ARM64 NW.js.

- Installation, maximized windows, the Steam-start prompt and complete uninstall passed on v0.5.2. Uninstall removes the launcher and its shortcuts while keeping the original game, saves and backups.
- Controller navigation, local save selection and copying work. MangoHud can be applied from Options.
- Manual Cloud upload completed, with the uploaded saves matching the ARM64 profile, Steam folder and Cloud cache.
- Xbox 360 controller emulation works in Desktop Mode, in both the launcher and game. The setting survives a reboot. Both Steam Deck and Xbox 360 emulation work in Gaming Mode; use Armada Control to switch there.

Gameplay was smooth, with no stutters during testing. The heaviest scene tested ran at **72 FPS / 13.9 ms at 720p**, in Balanced mode with underclocking and the GPU capped at **760 MHz**. Temperatures were **59°C GPU and 61°C CPU**.

## Build

Build on Linux ARM64 with a C compiler, binutils, Python 3, GTK3 development headers and pkg-config:

```sh
python3 build-installer.py
python3 tests/verify-installer.py dist
```

The release files are written to `dist/`. Setup downloads NW.js and uses the existing Steam game files. Running setup needs GTK3, curl, tar and an X11/Xwayland desktop session.

## Tests

With Node.js 22 or newer:

```sh
sh tests/run-tests.sh
```

These check installation, save copying, Cloud handling, Steam shortcuts, controller settings, uninstall and the curl installer. They use temporary files and simulated Steam/controller services. The test suite and release-file checks passed for v0.5.2.

For the installer and menu checks, install Xvfb and Openbox and use an ARM64 NW.js SDK runtime:

```sh
python3 tests/bootstrap-ui.py --gui
ALABASTER_UI_MENU_ONLY=1 node tests/options-ui.cjs /path/to/nwjs-sdk/nw
```

The menu checks cover the interface, not native window sizing. Maximized startup was tested directly in KDE.

## Still to test

- Downloading different Cloud saves into the ARM64 profile and loading that progress in-game.
- Recovery when a save or Cloud operation is interrupted.
- v0.5.2 on other devices and Steam accounts.

Cloud sync currently uses Steam's internal client interface, and save copying checks supported game builds. Steam or game updates may need a launcher update.
