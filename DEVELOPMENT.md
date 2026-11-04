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

The v0.5.0 source suite passed 191 checks across eight test files. The installer verification matched all 50 payload entries and the executable stored in the release archive.

## Tested scope

- The ARM64 full game reached gameplay on KPFE. Installation, menu navigation, local save selection and confirmed copying worked.
- Manual Cloud upload completed; the complete 12-file set matched the native profile, Steam folder and synchronized cache. The later cache-comparison refinement passed regression tests but has not had a further live upload.
- Desktop Xbox 360 switching worked in the launcher and game. An earlier intermittent input failure remains unexplained; reboot persistence and Gaming Mode authorization are not validated.
- Package contents are checked against the source manifest and archive. Runtime download, shortcut registration and uninstall have isolated test coverage.

Real Cloud-to-native replacement and restored-game loading, interruption recovery, broader device/account coverage and complete live uninstall remain unvalidated. Three additional automated pending-upload menu assertions were not executed to a result; the successful live upload and backend tests are separate evidence.

Cloud access uses Steam's internal local client interface. It can change with Steam updates. Save copying is restricted to inspected game-bundle hashes; a game update can require a launcher update. Original game files, native saves and backups are preserved by uninstall.
