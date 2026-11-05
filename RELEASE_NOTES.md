# Alabaster ARM64 v0.5.1 — prerelease

Run the installed Steam Linux version of Alabaster Dawn through native ARM64 NW.js.

- Full-screen setup, with a warning when Steam is not open. Installation can continue; add the Steam entry later from Options.
- Short explanations for setup, controller and uninstall options.
- Desktop Mode controller switching between Xbox 360 and Steam Deck. Use Xbox 360 for Desktop navigation and gameplay; use Armada Control in Gaming Mode.
- Optional MangoHud launch command: size 18, bottom right. Steam's performance overlay does not show GPU usage correctly for this game, so this adds an in-game HUD. **Disable the QAM performance overlay** to avoid duplicates, then relaunch.
- Updated validation notes for gameplay, Cloud upload, controller persistence and complete uninstall. Local save copying and manual Cloud sync remain available.

Start in Desktop Mode with Steam open and the full game's Linux version installed. Download **Alabaster-Dawn-Setup-linux-arm64.tar.gz**, extract it and open **Alabaster-Dawn-Setup.arm64**.

Requires an owned, installed Linux copy of the full game. Current target: **0.2.0-9**; runtime: **NW.js 0.119.2 ARM64**. Game data reuse and the existing-Steam-client Cloud approach may change in future releases.

This is a testing prerelease; see the README and validation notes for tested scope and remaining checks. No playable game files are included.
