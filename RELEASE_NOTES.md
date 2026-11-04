# Alabaster ARM64 v0.5.0 — prerelease

Native ARM64 launcher for the installed Steam Linux version of Alabaster Dawn.

- Automatic runtime setup, desktop/menu entries and Steam artwork.
- Local save copying with autosave, slot selection and backups.
- Manual Steam Cloud upload/download using the existing Steam login.
- Armada controller emulation and launcher uninstall options.
- Fixes the false Cloud recovery block after local save copies, including unnecessary retries caused by cache bookkeeping changes.

Download **Alabaster-Dawn-Setup-linux-arm64.tar.gz**, extract it and open **Alabaster-Dawn-Setup.arm64** in Desktop Mode. Steam should be open when registering the library entry.

Requires an owned, installed Linux copy of the full game. Current target: **0.2.0-9**; runtime: **NW.js 0.119.2 ARM64**. Game data reuse and the existing-Steam-client Cloud approach may change in future releases.

Gameplay and Cloud upload have been tested on KPFE. This is a testing prerelease; see the README and validation notes for current limits. No playable game files are included.
