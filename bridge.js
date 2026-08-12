// Bridge: phone <-> WebSocket <-> Claude Code (headless) <-> git
//
// Protocol (client -> server):
//   {type:"instruction", repo:"/abs/path", text:"..."}
//   {type:"approve", message:"commit message"}
//   {type:"reject"}
//
// Protocol (server -> client):
//   {type:"status", state:"..."}
//   {type:"log", chunk:"..."}
//   {type:"diff", diff:"..."}
//   {type:"result", ok:true|false, detail:"..."}
//   {type:"error", message:"..."}

const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((p) => p && path.resolve(p))
  .filter(Boolean);

if (!AUTH_TOKEN) {
  console.error("AUTH_TOKEN env var is required");
  process.exit(1);
}
if (ALLOWED_REPOS.length === 0) {
  console.error("ALLOWED_REPOS env var is required (comma-separated absolute paths)");
  process.exit(1);
}

function runGit(repo, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd: repo });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(" ")} exited ${code}`));
    });
  });
}

async function isTreeClean(repo) {
  const out = await runGit(repo, ["status", "--porcelain"]);
  return out.trim().length === 0;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ port: PORT });
console.log(`Bridge listening on ws://localhost:${PORT}`);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  if (token !== AUTH_TOKEN) {
    ws.close(4001, "unauthorized");
    return;
  }

  // Per-connection state: only one pending change-set at a time.
  let pending = null; // { repo, claudeProc }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (msg.type === "instruction") {
      if (pending) {
        send(ws, { type: "error", message: "a change-set is already pending approval" });
        return;
      }

      const repo = path.resolve(msg.repo || "");
      if (!ALLOWED_REPOS.includes(repo)) {
        send(ws, { type: "error", message: `repo not allowlisted: ${repo}` });
        return;
      }

      try {
        if (!(await isTreeClean(repo))) {
          send(ws, {
            type: "error",
            message: "working tree is not clean; commit or stash your changes first",
          });
          return;
        }
      } catch (e) {
        send(ws, { type: "error", message: `git status failed: ${e.message}` });
        return;
      }

      send(ws, { type: "status", state: "running" });

      const prompt =
        `${msg.text}\n\n` +
        `Make the necessary code changes in this repo. Do NOT run 'git commit' or 'git push' ` +
        `yourself — stop once the changes are made on disk.`;

      const claudeProc = spawn(
        "claude",
        ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "stream-json"],
        { cwd: repo }
      );
      pending = { repo, claudeProc };

      claudeProc.stdout.on("data", (d) => {
        send(ws, { type: "log", chunk: d.toString() });
      });
      claudeProc.stderr.on("data", (d) => {
        send(ws, { type: "log", chunk: d.toString() });
      });

      claudeProc.on("close", async (code) => {
        if (code !== 0) {
          send(ws, { type: "error", message: `claude exited with code ${code}` });
          pending = null;
          send(ws, { type: "status", state: "idle" });
          return;
        }

        try {
          const clean = await isTreeClean(repo);
          if (clean) {
            send(ws, { type: "status", state: "no_changes" });
            pending = null;
            return;
          }

          await runGit(repo, ["add", "-A"]);
          const diff = await runGit(repo, ["diff", "--cached"]);
          send(ws, { type: "diff", diff });
          send(ws, { type: "status", state: "awaiting_approval" });
        } catch (e) {
          send(ws, { type: "error", message: `post-run git failed: ${e.message}` });
          pending = null;
          send(ws, { type: "status", state: "idle" });
        }
      });
      return;
    }

    if (msg.type === "approve") {
      if (!pending) {
        send(ws, { type: "error", message: "nothing pending" });
        return;
      }
      const { repo } = pending;
      try {
        await runGit(repo, ["commit", "-m", msg.message || "Changes via bridge"]);
        await runGit(repo, ["push"]);
        send(ws, { type: "result", ok: true, detail: "committed and pushed" });
      } catch (e) {
        send(ws, { type: "result", ok: false, detail: e.message });
      } finally {
        pending = null;
        send(ws, { type: "status", state: "idle" });
      }
      return;
    }

    if (msg.type === "reject") {
      if (!pending) {
        send(ws, { type: "error", message: "nothing pending" });
        return;
      }
      const { repo } = pending;
      try {
        await runGit(repo, ["reset", "--hard", "HEAD"]);
        await runGit(repo, ["clean", "-fd"]);
        send(ws, { type: "result", ok: true, detail: "discarded" });
      } catch (e) {
        send(ws, { type: "result", ok: false, detail: e.message });
      } finally {
        pending = null;
        send(ws, { type: "status", state: "idle" });
      }
      return;
    }

    send(ws, { type: "error", message: `unknown message type: ${msg.type}` });
  });

  ws.on("close", () => {
    // Note: an in-flight claude process for this connection keeps running
    // and the change-set is left pending; reconnect and approve/reject it.
  });
});
