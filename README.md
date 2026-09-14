<div align="center">

# claude-usage

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Windows%20%7C%20macOS-supported-lightgrey)](#install)
[![CI](https://github.com/PandaProgParis/ClaudeUsage/actions/workflows/ci.yml/badge.svg)](https://github.com/PandaProgParis/ClaudeUsage/actions/workflows/ci.yml)

**A tray agent that keeps a snapshot of your claude.ai usage limits in a JSON file.**

🔑 **No API key** — it reads the same endpoint the claude.ai web app reads, using your own browser session.

</div>

---

## What it does

Every few minutes, quietly in the background:

1. asks claude.ai for your current usage limits,
2. writes the raw JSON to a file of your choice,
3. optionally POSTs it to a server you name.

Click the tray icon and you get your gauges — session, weekly, per-model — without opening a browser.

It is the account-side companion to [Claude Agents](https://github.com/PandaProgParis/ClaudeAgents), the VS Code extension that shows the Claude Code sessions running on your machine: Agents watches what your sessions do, claude-usage watches what they cost you in quota.

## Install

### From a release

Download from [Releases](../../releases):

| File | What it does |
|---|---|
| `claude-usage-<version>-setup.exe` | Windows installer. Start menu shortcut, clean uninstall. **Recommended** — a stable path means reliable start-at-login. |
| `claude-usage-<version>-portable.exe` | Single Windows executable, no install. Put it somewhere permanent before enabling start-at-login. |
| `claude-usage-<version>.dmg` | macOS disk image (Intel + Apple Silicon). |

Binaries are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn on first launch. On macOS: right-click the app → Open, or `xattr -dr com.apple.quarantine /Applications/claude-usage.app`.

### Verify what you downloaded

You have no reason to trust a stranger's `.exe`, so don't — check it instead.

Every release binary is built by GitHub Actions from the tagged commit, never
uploaded from a developer machine, and carries a signed provenance attestation:

```bash
gh attestation verify claude-usage-1.0.0-setup.exe --repo PandaProgParis/ClaudeUsage
```

That names the commit, the workflow file and the runner that produced the file.
The build log is public, and so is every line of source it was built from.

Each release also ships `SHA256SUMS.txt`:

```bash
sha256sum -c SHA256SUMS.txt                                    # Linux / macOS
Get-FileHash .\claude-usage-1.0.0-setup.exe -Algorithm SHA256   # Windows
```

### From source

```bash
git clone <this repo>
cd ClaudeUsage
npm install
npm start
```

## First launch

A claude.ai login window opens. Log in, and it closes itself. From then on the agent is invisible — it lives in the tray and never shows a window again, unless your session expires, in which case the login window comes back on its own.

Start-at-login is enabled on that first launch. Untick **Start at login** in the tray menu to turn it off.

## The tray

| Action | Result |
|---|---|
| Left click | The gauges panel: session (5 h), weekly, and one bar per model |
| Right click | Sync now · Log in again · Open the JSON / the config / the log · Start at login · Quit |
| Hover | Last reading plus gauges, on one line |

The interface follows your system locale: French on a French desktop, English everywhere else.

## Output

The **raw** payload of `GET /api/organizations/<id>/usage`, written atomically — a temp file then a rename, so a reader never catches a half-written file.

```json
{
  "five_hour": { "utilization": 0, "resets_at": null },
  "limits": [
    { "kind": "session", "percent": 0, "resets_at": null },
    { "kind": "weekly_all", "percent": 100, "resets_at": "2026-09-13T17:00:00Z" },
    {
      "kind": "weekly_scoped",
      "percent": 77,
      "resets_at": "2026-09-13T17:00:00Z",
      "scope": { "model": { "display_name": "Fable" } }
    }
  ]
}
```

Anthropic changes this payload from time to time; the agent stores it verbatim rather than a normalised shape of its own, so nothing is lost when they do.

## Configuration

`%APPDATA%/claude-usage/config.json` on Windows, `~/Library/Application Support/claude-usage/config.json` on macOS. Created on first launch:

```json
{
  "outputPath": "~/.claude-usage/usage.json",
  "intervalMinutes": 5,
  "endpoint": ""
}
```

| Key | Meaning |
|---|---|
| `outputPath` | Where to write the JSON. A leading `~` expands to your home directory. |
| `intervalMinutes` | How often to take a reading. Clamped to 1–1440. |
| `endpoint` | Optional `http(s)` URL to `POST` the payload to after each write — a dashboard, a webhook, your own API. Empty disables it. |

**The file is reloaded live** — save it and the new path, interval and endpoint apply immediately, with a reading straight away. Invalid JSON is ignored and logged rather than allowed to reset your settings.

A failed POST never invalidates a reading: the file on disk is the deliverable, the endpoint is a relay.

The same folder holds `claude-usage.log` (truncated at 1 MB) and the Chromium profile that keeps your claude.ai session.

## How it works

The usage endpoint is authenticated with a browser session, not an API key. So the agent keeps one hidden `BrowserWindow` parked on the claude.ai origin and runs the `fetch` **inside that page** — real cookies, real Chrome user agent, same-origin request. From the server's point of view it is the web app talking to its own API.

Between readings that window sits on `claude.ai/robots.txt`: the origin and its cookies are all that is needed, so there is no reason to keep the whole single-page app running in the background.

Your credentials never leave your machine. The agent never reads them — it only borrows the session cookie jar that Chromium holds for it, in a profile of its own.

## Privacy

Everything stays local unless you set `endpoint` yourself. No telemetry, no third-party service, no account beyond the claude.ai one you already have.

## Build

```bash
npm run dist:win     # NSIS installer + portable .exe → dist/
npm run dist:mac     # dmg, x64 + arm64 → dist/
npm test             # unit tests (vitest)
```

`dist:mac` **must run on macOS** — electron-builder cannot produce a dmg from Windows or Linux. Use a Mac or a `macos-latest` CI runner.

## Project layout

| Path | Role |
|---|---|
| `src/main.js` | Electron main process: hidden window, sync cycle, login, tray, autostart |
| `src/lib.js` | Pure logic — config, organization choice, payload validation, gauges, translations. No Electron, no I/O, fully tested |
| `src/preload.js` | IPC bridge between the panel and the agent |
| `src/panel.html` · `src/panel.js` | The gauges panel |
| `test/lib.test.js` | Unit tests |

The panel renders gauges that `lib.js` computed in the main process — it holds no logic of its own, which is what makes the interesting parts testable without a display.

## Notes

- **`ELECTRON_RUN_AS_NODE`** — some terminals (VS Code, Claude Code) export this, which turns `electron.exe` into plain Node and leaves you with no GUI. The agent detects it and relaunches itself cleanly without it.
- **Single instance** — launching it again while it runs opens the panel instead of starting a second agent.
- **Portable builds** — they unpack to a temp folder, so start-at-login registers the `.exe` you actually launched (`PORTABLE_EXECUTABLE_FILE`), not the temp copy. Keep the file somewhere permanent.

## License

MIT — see [LICENSE](LICENSE).
