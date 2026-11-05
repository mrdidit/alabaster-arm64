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

The v0.5.2 source suite passed 223 checks across eight test files. Uninstall coverage includes a connected game binding, recognized historical shortcuts, bundled notices, preservation of original files and rollback after a removal failure.

The curl installer passed 14 isolated checks using fake downloads and a fake setup executable. These cover archive checksums, unexpected archive contents, unsupported systems, setup exit status, cleanup and a truncated piped script. The public download route becomes available when the repository is made public; release assets are verified through authenticated GitHub access beforehand.

Installer verification matched all 52 embedded payload entries, current source files and the executable in the release archive. The same executable was copied to KPFE Downloads and its SHA-256 verified. Live v0.5.2 checks passed installation, maximized setup and launcher windows, the Steam-start prompt and complete uninstall.

The v0.5.2 isolated setup checks passed eight Steam-process detection cases, seven prompt outcomes and maximized windows with title bars, progress and cancellation at 1280×720. Steam startup was mocked in these checks. The private display environment excludes inherited Steam runtime and desktop-session settings.

The isolated NW.js startup test did not establish native window visibility or maximization. The later hands-on KDE test confirmed maximized launcher startup. The helper uses a browser window lookup and one visibility, focus and maximization request, with errors logged.

All 26 menu-only checks passed, including controller restrictions, MangoHud controls and persistent uninstall errors at 800×600. The backend was mocked; no real Steam settings, controller modes or saves changed.

Earlier v0.5.1 live testing passed Options navigation, Desktop Mode controller switching, the Gaming Mode restriction and MangoHud application.

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
- Complete uninstall passed on v0.5.2, including connected game files and shortcut cleanup. Original game files, saves and backups are preserved. An earlier v0.5.1 return to Options remains unexplained; v0.5.2 keeps errors on a dedicated screen instead of the Options footer.
- Package contents are checked against the source manifest and archive. Runtime download, shortcut registration and uninstall have isolated test coverage.

Real Cloud-to-native replacement and restored-game loading, interruption recovery and broader device/account coverage remain unvalidated.

Keep Steam signed in for Cloud actions: the integration uses Steam's internal local client interface, which can change with updates. Save copying accepts inspected game-bundle hashes; a game update can require a launcher update. Uninstall preserves original game files, native saves and backups.
