# Connector Bridge Control

Turns the repo you have open in VS Code into a target the Connector phone app can send instructions to: start a status-bar-controlled bridge, pair with a QR code, and review/approve or reject the changes an agent makes before anything is committed and pushed.

## What it does

- **Start** spins up a local WebSocket server, auto-detects an installed agent CLI (`claude`, `copilot`, or `codex`), and opens a public tunnel (via the `devtunnel` CLI) so the phone app can reach it.
- **Show QR Code** displays a pairing code for the phone app, scoped to the currently open workspace folder(s).
- **Stop** shuts both down.
- Every allowed repo is checked per-instruction against the connecting user's actual GitHub write/admin access to that repo — there's no separate shared secret to manage.

## Requirements

- The Connector mobile app installed on your phone — this is what you pair with by scanning the QR code.
- The [devtunnel CLI](https://aka.ms/devtunnel) installed and on your PATH — used to expose the bridge publicly for pairing.
- At least one agent CLI installed: [Claude Code](https://claude.com/claude-code), GitHub Copilot CLI, or Codex CLI. (Or point `connectorBridge.agentCommand` at something else.)
- A workspace folder open that's a git repo with a GitHub `origin` remote.

If either the tunnel CLI or an agent CLI is missing, starting the bridge will tell you exactly what's missing rather than failing silently.

## Settings

| Setting | Default | Description |
|---|---|---|
| `connectorBridge.port` | `8787` | Local port the bridge listens on. |
| `connectorBridge.tunnelId` | `connector-bridge` | devtunnel tunnel ID. |
| `connectorBridge.additionalRepos` | `[]` | Extra absolute repo paths to allow, beyond the open workspace folder(s). |
| `connectorBridge.agentCommand` | *(auto-detect)* | Override which agent CLI runs instructions. |
| `connectorBridge.agentArgs` | *(none)* | Argument template for `agentCommand`, `{prompt}` placeholder. |
| `connectorBridge.agentPriority` | `claude,copilot,codex` | Auto-detection order when `agentCommand` isn't set. |
| `connectorBridge.agentTimeoutSeconds` | `600` | How long to wait for an agent turn before treating it as stuck. |
| `connectorBridge.preventSleep` | `true` | Prevent Windows idle sleep while the bridge is running. |

## Security model

Opening the bridge makes every open workspace folder (plus anything in `connectorBridge.additionalRepos`) remotely controllable by anyone who presents a GitHub token with write access to that repo — access is checked against GitHub's collaborator-permission API on every instruction and again at approval time, not just once at connection time. Stop the bridge when you're not actively using it.

## Logs

All bridge and tunnel output goes to the **Connector Bridge** output channel (View → Output → Connector Bridge).
