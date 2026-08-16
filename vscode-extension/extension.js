const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { startBridgeServer } = require("../bridge-core");
const { startTunnelHost } = require("../tunnel-core");
const { generateQR } = require("../qr-core");

let statusBarItem;
let outputChannel;
let bridgeHandle = null; // { stop() }
let tunnelHandle = null; // { process, wsUrl, stop() }
let viewProvider;

function getAllowedRepos() {
  const cfg = vscode.workspace.getConfiguration("connectorBridge");
  const additional = cfg.get("additionalRepos", []);
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const all = [...folders, ...additional].filter(Boolean).map((p) => path.resolve(p));
  return [...new Set(all)];
}

function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

// Looks one directory down for a git repo, so we can point the user at it
// instead of silently starting the bridge against a non-repo folder.
function findGitRepoOneLevelDown(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .filter(isGitRepo);
}

/**
 * Checks each allowed repo path is actually a git repo. Returns
 * { ok: string[], problems: { folder: string, suggestions: string[] }[] }.
 */
function validateAllowedRepos(allowedRepos) {
  const ok = [];
  const problems = [];
  for (const repo of allowedRepos) {
    if (isGitRepo(repo)) {
      ok.push(repo);
    } else {
      problems.push({ folder: repo, suggestions: findGitRepoOneLevelDown(repo) });
    }
  }
  return { ok, problems };
}

function updateStatusBar(state) {
  if (state === "running") {
    statusBarItem.text = "$(radio-tower) Bridge: Running";
    statusBarItem.command = "connectorBridge.stop";
    statusBarItem.tooltip = "Click to stop the bridge + tunnel";
  } else if (state === "starting") {
    statusBarItem.text = "$(sync~spin) Bridge: Starting...";
    statusBarItem.command = undefined;
    statusBarItem.tooltip = "Starting the bridge + tunnel";
  } else {
    statusBarItem.text = "$(circle-slash) Bridge: Stopped";
    statusBarItem.command = "connectorBridge.start";
    statusBarItem.tooltip = "Click to start the bridge + tunnel";
  }
  statusBarItem.show();
  if (viewProvider) viewProvider.setState(state);
}

function showQRPanel(data) {
  const panel = vscode.window.createWebviewPanel(
    "connectorBridgeQR",
    "Connector Bridge — Scan to Connect",
    vscode.ViewColumn.One,
    { enableScripts: false }
  );
  panel.webview.html = `<!DOCTYPE html>
<html>
<body style="text-align:center; font-family: var(--vscode-font-family, sans-serif); padding: 2rem; color: var(--vscode-foreground);">
  <img src="${data.dataUrl}" width="280" height="280" style="image-rendering: pixelated; background: white; padding: 12px; border-radius: 8px;" />
  <p style="margin-top: 1.2em; font-size: 1em;">Scan with the Connector App.</p>
</body>
</html>`;
}

class BridgeViewProvider {
  constructor() {
    this.webviewView = null;
    this.state = "stopped";
    this.qrData = null;
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "start") vscode.commands.executeCommand("connectorBridge.start");
      if (msg.type === "stop") vscode.commands.executeCommand("connectorBridge.stop");
    });
    this.render();
  }

  setState(state) {
    this.state = state;
    this.render();
  }

  setQR(data) {
    this.qrData = data;
    this.render();
  }

  render() {
    if (!this.webviewView) return;

    const statusLabel =
      this.state === "running" ? "🟢 Running" : this.state === "starting" ? "🟡 Starting…" : "⚪ Stopped";
    const buttonDisabled = this.state === "starting" ? "disabled" : "";
    const buttonAction = this.state === "running" ? "stop" : "start";
    const buttonLabel = this.state === "running" ? "Stop Bridge" : this.state === "starting" ? "Starting…" : "Start Bridge";

    const qrHtml =
      this.state === "running" && this.qrData
        ? `<img src="${this.qrData.dataUrl}" alt="Pairing QR code" />
           <p class="hint" style="text-align:center;">Scan with the Connector App.</p>`
        : this.state === "running"
        ? `<p class="hint">Generating QR code…</p>`
        : `<p class="hint">Start the bridge to generate a pairing QR code.</p>`;

    this.webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
  .status { margin-bottom: 10px; font-weight: 600; }
  button {
    width: 100%; padding: 8px; font-size: 13px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 2px;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  img { width: 100%; max-width: 220px; display: block; margin: 14px auto 8px; background: white; padding: 8px; border-radius: 6px; }
  .meta { font-size: 11px; word-break: break-all; opacity: 0.85; margin: 4px 0; }
  .hint { font-size: 11px; opacity: 0.7; margin-top: 12px; }
</style>
</head>
<body>
  <div class="status">${statusLabel}</div>
  <button id="toggle" ${buttonDisabled}>${buttonLabel}</button>
  ${qrHtml}
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("toggle").addEventListener("click", () => {
      vscode.postMessage({ type: "${buttonAction}" });
    });
  </script>
</body>
</html>`;
  }
}

async function displayQR({ port, tunnelId, repo }) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating QR code..." },
    async () => {
      try {
        const data = await generateQR({ port, tunnelId, repo });
        showQRPanel(data);
        if (viewProvider) viewProvider.setQR(data);
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to generate QR: ${e.message}`);
      }
    }
  );
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Connector Bridge");
  context.subscriptions.push(outputChannel);

  viewProvider = new BridgeViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("connectorBridge.panel", viewProvider)
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  updateStatusBar("stopped");
  context.subscriptions.push(statusBarItem);

  const start = vscode.commands.registerCommand("connectorBridge.start", async () => {
    if (bridgeHandle) {
      vscode.window.showInformationMessage("Bridge is already running.");
      return;
    }

    const requestedRepos = getAllowedRepos();
    if (requestedRepos.length === 0) {
      vscode.window.showErrorMessage(
        "No folder open to use as the bridge target. Open a repo, or set connectorBridge.additionalRepos in settings."
      );
      return;
    }

    const { ok: allowedRepos, problems } = validateAllowedRepos(requestedRepos);
    if (problems.length > 0) {
      for (const { folder, suggestions } of problems) {
        if (suggestions.length > 0) {
          const message = `"${folder}" is not a git repository. Found ${
            suggestions.length > 1 ? "git repos" : "a git repo"
          } one level down: ${suggestions.join(", ")}. Open that folder directly in VS Code (File > Open Folder), then start the bridge again.`;
          outputChannel.appendLine(`[bridge] ${message}`);
          vscode.window.showErrorMessage(message);
        } else {
          const message = `"${folder}" is not a git repository, and none was found in its subfolders. Open the folder containing your git repo, then start the bridge again.`;
          outputChannel.appendLine(`[bridge] ${message}`);
          vscode.window.showErrorMessage(message);
        }
      }
      if (allowedRepos.length === 0) return;
    }

    const cfg = vscode.workspace.getConfiguration("connectorBridge");
    const port = cfg.get("port", 8787);
    const tunnelId = cfg.get("tunnelId", "connector-bridge");

    outputChannel.show(true);
    outputChannel.appendLine(`Starting bridge for: ${allowedRepos.join(", ")}`);
    updateStatusBar("starting");

    try {
      bridgeHandle = await startBridgeServer(
        {
          port,
          allowedRepos,
          agentCmd: cfg.get("agentCommand") || undefined,
          agentArgsTemplate: cfg.get("agentArgs") || undefined,
          agentPriority: cfg.get("agentPriority", "claude,copilot,codex"),
          agentTimeoutMs: cfg.get("agentTimeoutSeconds", 600) * 1000,
          preventSleep: cfg.get("preventSleep", true),
          keepAwakeScriptPath: path.join(context.extensionPath, "dist", "keep-awake.ps1"),
        },
        { log: (line) => outputChannel.appendLine(line) }
      );

      tunnelHandle = startTunnelHost({ tunnelId, port, stdio: "pipe" });
      tunnelHandle.process.stdout.on("data", (d) => outputChannel.append(d.toString()));
      tunnelHandle.process.stderr.on("data", (d) => outputChannel.append(d.toString()));
      tunnelHandle.process.on("error", (e) => {
        outputChannel.appendLine(
          e.code === "ENOENT"
            ? "[tunnel] devtunnel CLI not found on PATH. Install it: https://aka.ms/devtunnel"
            : `[tunnel] failed to start: ${e.message}`
        );
      });

      updateStatusBar("running");
      await displayQR({ port, tunnelId, repo: allowedRepos[0] });
    } catch (e) {
      const isDevtunnelMissing = e.code === "ENOENT";
      const hint = isDevtunnelMissing
        ? " The devtunnel CLI isn't installed — get it from https://aka.ms/devtunnel."
        : e.code === "EADDRINUSE"
        ? ` Port ${port} is already in use — change connectorBridge.port in settings.`
        : "";
      outputChannel.appendLine(`[bridge] failed to start: ${e.message}`);
      vscode.window.showErrorMessage(`Connector Bridge failed to start: ${e.message}.${hint}`);

      if (bridgeHandle) bridgeHandle.stop();
      bridgeHandle = null;
      tunnelHandle = null;
      if (viewProvider) viewProvider.setQR(null);
      updateStatusBar("stopped");
    }
  });

  const stop = vscode.commands.registerCommand("connectorBridge.stop", () => {
    if (!bridgeHandle && !tunnelHandle) {
      vscode.window.showInformationMessage("Bridge is not running.");
      return;
    }
    if (tunnelHandle) tunnelHandle.stop();
    if (bridgeHandle) bridgeHandle.stop();
    tunnelHandle = null;
    bridgeHandle = null;
    outputChannel.appendLine("Stopped.");
    if (viewProvider) viewProvider.setQR(null);
    updateStatusBar("stopped");
  });

  const showQR = vscode.commands.registerCommand("connectorBridge.showQR", async () => {
    const { ok: allowedRepos } = validateAllowedRepos(getAllowedRepos());
    if (allowedRepos.length === 0) {
      vscode.window.showErrorMessage("No folder open to pair. Open a repo first.");
      return;
    }
    if (!bridgeHandle) {
      vscode.window.showWarningMessage("Bridge isn't running — start it first so this QR code will actually work.");
    }

    const cfg = vscode.workspace.getConfiguration("connectorBridge");
    const port = cfg.get("port", 8787);
    const tunnelId = cfg.get("tunnelId", "connector-bridge");

    await displayQR({ port, tunnelId, repo: allowedRepos[0] });
  });

  const toggle = vscode.commands.registerCommand("connectorBridge.toggle", () => {
    vscode.commands.executeCommand(bridgeHandle ? "connectorBridge.stop" : "connectorBridge.start");
  });

  context.subscriptions.push(start, stop, showQR, toggle);
}

function deactivate() {
  if (tunnelHandle) tunnelHandle.stop();
  if (bridgeHandle) bridgeHandle.stop();
}

module.exports = { activate, deactivate };
