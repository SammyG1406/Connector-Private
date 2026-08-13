const vscode = require("vscode");
const { execFile } = require("child_process");

let terminal = null;
let statusBarItem;

function getProjectPath() {
  const configured = vscode.workspace.getConfiguration("connectorBridge").get("projectPath");
  if (configured) return configured;
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return null;
}

function requireProjectPath() {
  const projectPath = getProjectPath();
  if (!projectPath) {
    vscode.window.showErrorMessage(
      "No bridge project path found. Open the bridge repo as your workspace, or set connectorBridge.projectPath in settings."
    );
  }
  return projectPath;
}

function updateStatusBar() {
  if (terminal) {
    statusBarItem.text = "$(radio-tower) Bridge: Running";
    statusBarItem.command = "connectorBridge.stop";
    statusBarItem.tooltip = "Click to stop the bridge + tunnel";
  } else {
    statusBarItem.text = "$(circle-slash) Bridge: Stopped";
    statusBarItem.command = "connectorBridge.start";
    statusBarItem.tooltip = "Click to start the bridge + tunnel";
  }
  statusBarItem.show();
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
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
  <p><b>ws:</b> ${escapeHtml(data.ws)}</p>
  <p><b>repo:</b> ${escapeHtml(data.repo)}</p>
  <p style="opacity: 0.7; font-size: 0.9em;">Scan with the bridge app, or enter these fields manually. No secret is encoded — the app authorizes via its own GitHub login.</p>
</body>
</html>`;
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  updateStatusBar();
  context.subscriptions.push(statusBarItem);

  const start = vscode.commands.registerCommand("connectorBridge.start", () => {
    if (terminal) {
      vscode.window.showInformationMessage("Bridge is already running.");
      return;
    }
    const projectPath = requireProjectPath();
    if (!projectPath) return;

    terminal = vscode.window.createTerminal({ name: "Connector Bridge", cwd: projectPath });
    terminal.show();
    terminal.sendText("npm run dev");
    updateStatusBar();
  });

  const stop = vscode.commands.registerCommand("connectorBridge.stop", () => {
    if (!terminal) {
      vscode.window.showInformationMessage("Bridge is not running.");
      return;
    }
    terminal.dispose();
    terminal = null;
    updateStatusBar();
  });

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        terminal = null;
        updateStatusBar();
      }
    })
  );

  const showQR = vscode.commands.registerCommand("connectorBridge.showQR", () => {
    const projectPath = requireProjectPath();
    if (!projectPath) return;

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Generating QR code..." },
      () =>
        new Promise((resolve) => {
          execFile("node", ["qr.js", "--json"], { cwd: projectPath }, (err, stdout, stderr) => {
            resolve();
            if (err) {
              vscode.window.showErrorMessage(`Failed to generate QR: ${stderr || err.message}`);
              return;
            }
            let data;
            try {
              data = JSON.parse(stdout);
            } catch (e) {
              vscode.window.showErrorMessage(`Could not parse QR output: ${e.message}`);
              return;
            }
            showQRPanel(data);
          });
        })
    );
  });

  context.subscriptions.push(start, stop, showQR);
}

function deactivate() {
  if (terminal) terminal.dispose();
}

module.exports = { activate, deactivate };
