# Changelog

## 0.1.0

- The bridge server, devtunnel hosting, and QR pairing now run in-process inside the extension — no separate `npm run dev` terminal, and no dependency on the extension's workspace being a checkout of this repo.
- Allowed repos are now derived from the open workspace folder(s) (plus `connectorBridge.additionalRepos`) instead of a manually-set `connectorBridge.projectPath`.
- Configuration moved from a `.env` file to VS Code settings (`connectorBridge.*`).
- Bridge and tunnel logs now go to a "Connector Bridge" output channel instead of a terminal.
- Startup failures (port already in use, `devtunnel` CLI missing, no agent CLI found) now surface as a clear error notification instead of a silent or cryptic failure.

## 0.0.1

- Initial version: status bar start/stop wrapping `npm run dev` in a terminal, and a QR pairing webview backed by `node qr.js --json`.
