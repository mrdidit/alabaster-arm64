# Alabaster ARM64

An unofficial ARM64 launcher for **Alabaster Dawn on Armada Linux**. It runs the game's JavaScript/WebGL files through native ARM64 NW.js, with no Proton needed for the game.

Inspired by the Android wrappers [alabaster-android](https://github.com/moronigranja/alabaster-android) and [AlabasterDawnBox](https://github.com/AerithMetiq/AlabasterDawnBox).

## Install

1. Install the full game's **Linux version** through Steam.
2. Download and extract **Alabaster-Dawn-Setup-linux-arm64.tar.gz** from [Releases](https://github.com/mrdidit/alabaster-arm64/releases).
3. In Desktop Mode, open **Alabaster-Dawn-Setup.arm64**. It downloads and checks the required runtime automatically.
4. Choose **Install**, confirm the detected game folder, then **Play Alabaster Dawn**.

Keep Steam open during setup to add the ARM64 library entry and artwork. Desktop and application-menu entries are also created. If Steam registration needs another try, use **Options → Add / update Steam entry**. After setup, play from Gaming Mode or Desktop Mode.

## Features

- Controller, keyboard and touch navigation.
- Local save copying in either direction: autosave, individual slots, multiple selections or All, with dates and backups.
- Manual **Steam Cloud download and upload** using the existing Steam login.
- Steam Deck / Xbox 360 controller emulation through Armada. This setting applies across the device.
- Disconnect game files or uninstall the launcher from Options. Original game files, saves and backups are kept.

## Saves and game files

For now, the launcher uses the existing Steam installation and Steam's running client for Cloud access. Those choices may change in a future release. No playable game files are bundled; an owned copy is required.

Cloud actions are manual and transfer the complete save set. Keep Steam signed in and the original game closed. **Local saves** only copies between local folders; it does not upload to Cloud. Pending local copies can then be uploaded through **Cloud sync → Upload ARM64 saves**.

**v0.5.0 is a testing prerelease.** Current target: full game **0.2.0-9**, with **NW.js 0.119.2 ARM64**. Gameplay and Cloud upload have been tested on KPFE; broader device coverage and Cloud restore/recovery still need testing. [Validation and build notes](DEVELOPMENT.md) · [Credits](THIRD_PARTY.md)
