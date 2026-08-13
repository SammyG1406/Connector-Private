// Bridge: phone <-> WebSocket <-> Claude Code (headless) <-> git
//
// Connect with ?githubToken=<GitHub OAuth token>. Authorization isn't a
// shared secret — each instruction is checked against GitHub's own
// collaborator-permission API for the target repo (write/admin required).
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

require("dotenv").config({ quiet: true });
const { WebSocketServer } = require("ws");
const spawn = require("cross-spawn");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled rejection]", e));

// On Windows, "claude" resolves to claude.cmd, a shim that cross-spawn can only
// invoke via cmd.exe — which mangles flags like --dangerously-skip-permissions
// in practice. Resolve straight to the real claude.exe to skip that layer.
function resolveClaudeCommand() {
  if (process.platform !== "win32") return "claude";
  try {
    const cmdPath = execSync("where claude.cmd", { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    const exePath = path.join(
      path.dirname(cmdPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    if (fs.existsSync(exePath)) return exePath;
  } catch {
    // fall through
  }
  return "claude";
}
const CLAUDE_CMD = resolveClaudeCommand();

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((p) => p && path.resolve(p))
  .filter(Boolean);

if (ALLOWED_REPOS.length === 0) {
  console.error("ALLOWED_REPOS env var is required (comma-separated absolute paths)");
  process.exit(1);
}

// Parses "https://github.com/owner/repo.git" or "git@github.com:owner/repo.git"
function parseGithubRemote(remoteUrl) {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Authorization is delegated to GitHub itself: the presented token must belong
// to an account with write (or admin) access to the specific repo being
// targeted. This replaces a shared bearer secret with a real identity check —
// a leaked QR code is useless without a GitHub account GitHub itself vouches
// for on this repo.
async function checkGithubPermission(githubToken, repoPath) {
  if (!fs.existsSync(repoPath)) {
    return { ok: false, reason: `repo folder no longer exists on disk: ${repoPath}` };
  }

  let remoteUrl;
  try {
    remoteUrl = (await runGit(repoPath, ["remote", "get-url", "origin"])).trim();
  } catch (e) {
    return { ok: false, reason: `could not read git remote: ${e.message}` };
  }

  const parsed = parseGithubRemote(remoteUrl);
  if (!parsed) {
    return { ok: false, reason: `remote "${remoteUrl}" is not a recognizable GitHub URL` };
  }

  const headers = {
    Authorization: `Bearer ${githubToken}`,
    "User-Agent": "connector-bridge",
    Accept: "application/vnd.github+json",
  };

  let userRes;
  try {
    userRes = await fetch("https://api.github.com/user", { headers });
  } catch (e) {
    return { ok: false, reason: `could not reach GitHub: ${e.message}` };
  }
  if (!userRes.ok) {
    return { ok: false, reason: `GitHub token invalid or expired (status ${userRes.status})` };
  }
  const user = await userRes.json();

  let permRes;
  try {
    permRes = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/collaborators/${user.login}/permission`,
      { headers }
    );
  } catch (e) {
    return { ok: false, reason: `could not reach GitHub: ${e.message}` };
  }
  if (!permRes.ok) {
    if (permRes.status === 404) {
      return {
        ok: false,
        reason: `${parsed.owner}/${parsed.repo} not found on GitHub — it may have been deleted, renamed, or made inaccessible to this account`,
      };
    }
    return {
      ok: false,
      reason: `could not check ${user.login}'s access to ${parsed.owner}/${parsed.repo} (status ${permRes.status})`,
    };
  }
  const { permission } = await permRes.json();
  if (permission === "admin" || permission === "write") {
    return { ok: true, username: user.login };
  }
  return {
    ok: false,
    reason: `${user.login} has "${permission}" access to ${parsed.owner}/${parsed.repo}; write access required`,
  };
}

function runGit(repo, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd: repo });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
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
  const githubToken = url.searchParams.get("githubToken");
  if (!githubToken) {
    ws.close(4001, "missing githubToken");
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

      const permCheck = await checkGithubPermission(githubToken, repo);
      if (!permCheck.ok) {
        send(ws, { type: "error", message: `not authorized: ${permCheck.reason}` });
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
        CLAUDE_CMD,
        ["-p", prompt, "--dangerously-skip-permissions", "--continue"],
        { cwd: repo }
      );
      pending = { repo, claudeProc };

      claudeProc.stdout.on("data", (d) => {
        send(ws, { type: "log", chunk: d.toString() });
      });
      claudeProc.stderr.on("data", (d) => {
        send(ws, { type: "log", chunk: d.toString() });
      });
      let spawnFailed = false;
      claudeProc.on("error", (e) => {
        spawnFailed = true;
        send(ws, { type: "error", message: `failed to start claude: ${e.message}` });
        pending = null;
        send(ws, { type: "status", state: "idle" });
      });

      claudeProc.on("close", async (code) => {
        if (spawnFailed) return;
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

      // Re-check rather than trust the check from instruction-time: access
      // can be revoked, or the repo deleted, while a diff sits awaiting review.
      const permCheck = await checkGithubPermission(githubToken, repo);
      if (!permCheck.ok) {
        send(ws, { type: "error", message: `not authorized: ${permCheck.reason}` });
        pending = null;
        send(ws, { type: "status", state: "idle" });
        return;
      }

      try {
        await runGit(repo, ["commit", "-m", msg.message || "Changes via bridge"]);
        try {
          await runGit(repo, ["push"]);
          send(ws, { type: "result", ok: true, detail: "committed and pushed" });
        } catch (pushErr) {
          send(ws, {
            type: "result",
            ok: false,
            detail: `committed locally but push failed (a local commit now exists, unpushed): ${pushErr.message}`,
          });
        }
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
      if (!fs.existsSync(repo)) {
        send(ws, {
          type: "result",
          ok: false,
          detail: `repo folder no longer exists on disk: ${repo}`,
        });
        pending = null;
        send(ws, { type: "status", state: "idle" });
        return;
      }
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
