# Alabaster ARM64 v0.5.2 — prerelease

Run the installed Steam Linux version of Alabaster Dawn through native ARM64 NW.js.

- Maximized setup and launcher windows, with normal title bars in Desktop Mode.
- Manual download or a curl installer that verifies the release archive and opens the same setup app.
- Updated curl installer: SSH launches can find the same user's desktop session and open setup on the device. The v0.5.2 setup application is unchanged.
- A persistent **Start Steam / Continue without Steam / Cancel** prompt before setup when Steam is closed.
- Complete uninstall includes recognized old ARM64 shortcuts and bundled attribution files. Original game files, saves and backups remain untouched.
- Uninstall errors stay visible on a dedicated screen instead of returning to Options with a footer message.
- Desktop Mode controller switching between Xbox 360 and Steam Deck. Use Xbox 360 for Desktop navigation and gameplay; use Armada Control in Gaming Mode.
- Optional MangoHud launch command: size 18, bottom right. Steam's performance overlay does not show GPU usage correctly for this game, so this adds an in-game HUD. **Disable the QAM performance overlay** to avoid duplicates, then relaunch.
- Local save copying and manual Cloud sync remain available.

Start in Desktop Mode with Steam open and the full game's Linux version installed. Download **Alabaster-Dawn-Setup-linux-arm64.tar.gz**, extract it and open **Alabaster-Dawn-Setup.arm64**.

Or run:

```sh
curl -fsSL https://github.com/mrdidit/alabaster-arm64/releases/download/v0.5.2/install.sh | bash
```

For SSH installation, use the same account signed into Desktop Mode. Setup opens on the device; keep the terminal connected until it closes.

Live v0.5.2 checks passed installation, maximized windows, the Steam-start prompt and complete uninstall.

Requires an owned, installed Linux copy of the full game. Current target: **0.2.0-9**; runtime: **NW.js 0.119.2 ARM64**. Game data reuse and the existing-Steam-client Cloud approach may change in future releases.

This is a testing prerelease; see the README and validation notes for tested scope and remaining checks. No playable game files are included.
