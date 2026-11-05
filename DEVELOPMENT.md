# Build and validation

Build on Linux ARM64 with a C compiler, binutils, Python 3, GTK3 development headers and pkg-config:

```sh
python3 build-installer.py
python3 tests/verify-installer.py dist
```

The build embeds the launcher, menu and fonts. It does not download the runtime or game. Setup needs GTK3, curl, tar and an X11/Xwayland session, as provided by the tested Armada installation.

Run the self-contained tests with Node.js 22 or newer:

```sh
sh tests/run-tests.sh
```

Tests use disposable saves and mocked Steam/controller interfaces. They do not sign in, transfer real saves, change controller settings or require proprietary game files. Private device captures and game source are not included.

The v0.5.1 source suite passed 215 checks across eight test files. The installer verification matched all 50 payload entries and the executable stored in the release archive.

Additional isolated UI checks covered full-screen setup at 1280×720, the Steam warning, progress and cancellation, plus 16 menu checks at 1280×720 and 800×600. The menu used a mocked backend: no real Steam settings, controller modes or saves changed. These checks cover the new MangoHud action and Gaming Mode restriction; live device validation of those new controls is still pending.

To repeat the UI checks, install Xvfb and Openbox and supply an ARM64 NW.js SDK runtime:

```sh
python3 tests/bootstrap-ui.py --gui
node tests/options-ui.cjs /path/to/nwjs-sdk/nw
```

## Tested scope

- The ARM64 full game ran on KPFE (Snapdragon 8 Elite). Installation, menu navigation, local save selection and confirmed copying worked.
- Gameplay was smooth, with no observed stutters. The heaviest tested scene ran at 72 FPS / 13.9 ms at 720p in Balanced mode with a substantial underclock and a 760 MHz GPU limit; GPU temperature was 59°C and CPU temperature 61°C. These are hands-on results for that setup, not a benchmark across devices or game scenes.
- Manual Cloud upload completed; the complete 12-file set matched the native profile, Steam folder and synchronized cache. The later cache-comparison refinement passed regression tests and a live upload succeeded.
- Desktop Mode Xbox 360 switching worked in the launcher and game, including persistence after reboot. Gaming Mode authorization failed; launcher-side switching is now limited to Desktop Mode. Use Armada Control in Gaming Mode, where both emulation modes work.
- Complete live uninstall worked, preserving original game files, saves and backups.
- Package contents are checked against the source manifest and archive. Runtime download, shortcut registration and uninstall have isolated test coverage.

Real Cloud-to-native replacement and restored-game loading, interruption recovery and broader device/account coverage remain unvalidated.

Keep Steam signed in for Cloud actions: the integration uses Steam's internal local client interface, which can change with updates. Save copying accepts inspected game-bundle hashes; a game update can require a launcher update. Uninstall preserves original game files, native saves and backups.
