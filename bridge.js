// Bridge: phone <-> WebSocket <-> agent CLI (headless) <-> git
//
// Connect with ?githubToken=<GitHub OAuth token>. Authorization isn't a
// shared secret — each instruction is checked against GitHub's own
// collaborator-permission API for the target repo (write/admin required).
//
// Which agent CLI runs instructions is auto-detected at startup: tries
// claude, copilot, codex (in that order, see AGENT_PRIORITY) and uses
// whichever is actually installed. Override entirely with AGENT_CMD (plus
// optional AGENT_ARGS, a template using {prompt}) to point at anything else.
//
// Controller protocol (client -> server):
//   {type:"instruction", repo:"/abs/path", text:"..."}
//   {type:"approve", message:"commit message"}
//   {type:"reject"}
//
// Server -> client (both controllers and observers receive these):
//   {type:"status", state:"..."}
//   {type:"log", chunk:"..."}
//   {type:"diff", diff:"..."}
//   {type:"result", ok:true|false, detail:"..."}
//   {type:"error", message:"..."}
//
// Observer mode: connect with ?observer=true&repo=/abs/path (in addition to
// githubToken). Read-only — requires only read access to the repo, not
// write — and receives the same status/log/diff/result stream a controller
// working on that repo sees, without being able to send instructions or
// approve/reject.

require("dotenv").config({ quiet: true });
const { WebSocketServer } = require("ws");
const spawn = require("cross-spawn");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled rejection]", e));

// On Windows, npm-installed CLIs resolve to a .cmd shim that cross-spawn can
// only invoke via cmd.exe — which has repeatedly mangled flags like
// --dangerously-skip-permissions in practice. Rather than hardcode each
// tool's install layout, parse the shim's own script to find what it
// actually invokes (a direct .exe, or node + a .js entry point) and spawn
// that directly, skipping cmd.exe entirely. Verified against both shapes:
// claude.cmd (direct .exe) and codex.cmd/copilot.cmd (node + .js).
function resolveWindowsShim(toolName) {
  let cmdPath;
  try {
    cmdPath = execSync(`where ${toolName}.cmd`, { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
  if (!cmdPath || !fs.existsSync(cmdPath)) return null;

  const content = fs.readFileSync(cmdPath, "utf8");
  const dp0 = path.dirname(cmdPath) + path.sep;
  const resolveDp0 = (s) => s.replace(/%dp0%/gi, dp0);

  let m = content.match(/"([^"]+\.exe)"\s*%\*/i);
  if (m) {
    const exePath = path.normalize(resolveDp0(m[1]));
    return fs.existsSync(exePath) ? { cmd: exePath, prefixArgs: [] } : null;
  }

  m = content.match(/"([^"]+\.js)"\s*%\*/i);
  if (m) {
    const script = path.normalize(resolveDp0(m[1]));
    if (!fs.existsSync(script)) return null;
    const localNode = path.join(dp0, "node.exe");
    const node = fs.existsSync(localNode) ? localNode : "node";
    return { cmd: node, prefixArgs: [script] };
  }
  return null;
}

function resolveAgentCommand(toolName) {
  if (process.platform === "win32") {
    const resolved = resolveWindowsShim(toolName);
    if (resolved) return resolved;
  }
  return { cmd: toolName, prefixArgs: [] };
}

function checkCommandAvailable(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {});
    let failed = false;
    proc.on("error", () => {
      failed = true;
      resolve(false);
    });
    proc.on("close", (code) => {
      if (!failed) resolve(code === 0);
    });
  });
}

function truncate(s, n = 150) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Each summarizer takes one parsed JSONL event from a tool's structured
// output mode and returns either a short human-readable line (a bullet
// point, no raw code/diffs) or null to skip it entirely. Built from real
// event streams captured against actual installs on this machine — not
// guessed — except where noted.

// Verified against a real successful run (file write + read-back).
function summarizeClaudeEvent(ev) {
  if (ev.type === "assistant" && ev.message?.content) {
    const lines = [];
    for (const block of ev.message.content) {
      if (block.type === "tool_use") {
        const target = block.input?.file_path || block.input?.command || block.input?.pattern || "";
        lines.push(`• ${block.name}${target ? `: ${truncate(target)}` : ""}`);
      } else if (block.type === "text" && block.text?.trim()) {
        lines.push(`• ${truncate(block.text, 200)}`);
      }
    }
    return lines.length ? lines.join("\n") : null;
  }
  if (ev.type === "user" && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return `⚠ Error: ${truncate(text, 200)}`;
      }
    }
    return null;
  }
  if (ev.type === "result") {
    return ev.is_error ? `✗ Failed: ${truncate(ev.result || "unknown error", 200)}` : "✓ Done";
  }
  return null;
}

// Verified against a real successful run (file write + read-back).
function summarizeCopilotEvent(ev) {
  if (ev.ephemeral === true) return null;
  if (ev.type === "tool.execution_start") {
    const a = ev.data?.arguments || {};
    const target = a.path || a.command || a.query || "";
    return `• ${ev.data?.toolName}${target ? `: ${truncate(target)}` : ""}`;
  }
  if (ev.type === "tool.execution_complete") {
    if (ev.data?.success === false) {
      return `⚠ Error: ${truncate(ev.data?.result?.content || "tool failed", 200)}`;
    }
    return null; // tool_start already announced it; skip the (verbose) completion payload
  }
  if (ev.type === "assistant.message" && ev.data?.content?.trim()) {
    return `• ${truncate(ev.data.content, 200)}`;
  }
  if (ev.type === "result") {
    return ev.exitCode === 0 ? "✓ Done" : `✗ Failed (exit ${ev.exitCode})`;
  }
  return null;
}

// Best-effort: only the error path (item.completed type:"error", turn.failed)
// was verified against a real run — no OpenAI-authenticated account was
// available on this machine to exercise the success path. Unrecognized
// item types fall back to a generic short line rather than dumping raw
// content, so an actual schema mismatch degrades safely instead of leaking
// verbose output back through.
function summarizeCodexEvent(ev) {
  if (ev.type === "error") return `⚠ Error: ${truncate(ev.message, 200)}`;
  if (ev.type === "turn.failed") {
    return `✗ Failed: ${truncate(ev.error?.message || "unknown error", 200)}`;
  }
  if (ev.type === "item.completed" && ev.item) {
    const item = ev.item;
    if (item.type === "error") return `⚠ Error: ${truncate(item.message, 200)}`;
    if (item.type === "agent_message" && item.text) return `• ${truncate(item.text, 200)}`;
    if (item.type === "command_execution" && item.command) {
      return `• Running: ${truncate(item.command, 150)}`;
    }
    if (item.type === "file_change" && item.path) return `• Editing: ${truncate(item.path, 150)}`;
    return `• ${item.type || "step"} completed`;
  }
  if (ev.type === "turn.completed" || ev.type === "thread.completed") return "✓ Done";
  return null;
}

const SUMMARIZERS = {
  claude: summarizeClaudeEvent,
  copilot: summarizeCopilotEvent,
  codex: summarizeCodexEvent,
};

// Known agent CLIs, tried in priority order (AGENT_PRIORITY) at startup —
// first one that's actually installed wins. Each buildArgs(prompt) returns
// the args for a fresh, non-interactive, no-confirmation-prompts run, using
// each tool's structured JSONL output mode so summarizeXEvent() above can
// turn it into concise lines instead of forwarding raw text. Flags verified
// directly against each tool's --help, not guessed.
const KNOWN_AGENTS = {
  claude: {
    cmd: "claude",
    versionArgs: ["--version"],
    buildArgs: (prompt) => [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--continue",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
  },
  copilot: {
    cmd: "copilot",
    versionArgs: ["--version"],
    buildArgs: (prompt) => [
      "-p",
      prompt,
      "--allow-all-tools",
      "--continue",
      "--output-format",
      "json",
    ],
  },
  codex: {
    cmd: "codex",
    versionArgs: ["--version"],
    buildArgs: (prompt) => ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "--json"],
  },
};

const AGENT_CMD_OVERRIDE = process.env.AGENT_CMD;
const AGENT_ARGS_OVERRIDE = process.env.AGENT_ARGS; // template string, {prompt} placeholder
const AGENT_PRIORITY = (process.env.AGENT_PRIORITY || "claude,copilot,codex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let SELECTED_AGENT = null; // { label, cmd, prefixArgs, buildArgs }

async function selectAgent() {
  if (AGENT_CMD_OVERRIDE) {
    const template = AGENT_ARGS_OVERRIDE || "-p {prompt} --dangerously-skip-permissions";
    const resolved = resolveAgentCommand(AGENT_CMD_OVERRIDE);
    const buildArgs = (prompt) => [
      ...resolved.prefixArgs,
      ...template.split(" ").map((tok) => (tok === "{prompt}" ? prompt : tok)),
    ];
    const ok = await checkCommandAvailable(resolved.cmd, [...resolved.prefixArgs, "--version"]);
    if (!ok) {
      console.error(
        `[agent] AGENT_CMD="${AGENT_CMD_OVERRIDE}" does not appear to be usable ` +
          `(checked --version). Instructions will fail until this is fixed.`
      );
    } else {
      console.log(`[agent] using "${AGENT_CMD_OVERRIDE}" (from AGENT_CMD)`);
    }
    SELECTED_AGENT = { label: AGENT_CMD_OVERRIDE, cmd: resolved.cmd, buildArgs };
    return;
  }

  for (const name of AGENT_PRIORITY) {
    const known = KNOWN_AGENTS[name];
    if (!known) continue;
    const resolved = resolveAgentCommand(known.cmd);
    const ok = await checkCommandAvailable(resolved.cmd, [
      ...resolved.prefixArgs,
      ...known.versionArgs,
    ]);
    if (ok) {
      SELECTED_AGENT = {
        label: name,
        cmd: resolved.cmd,
        buildArgs: (prompt) => [...resolved.prefixArgs, ...known.buildArgs(prompt)],
      };
      console.log(`[agent] using "${name}"`);
      return;
    }
  }

  console.error(
    `[agent] none of the known tools (${AGENT_PRIORITY.join(", ")}) were found. ` +
      `Set AGENT_CMD in .env to point at whichever CLI you have installed. ` +
      `Instructions will fail with a clear error until this is fixed.`
  );
}

const PORT = Number(process.env.PORT || 8787);
// Some agent CLIs block on an interactive prompt (e.g. a first-run login)
// instead of failing fast when misconfigured — observed directly with an
// unauthenticated copilot session. Without a timeout that hangs a "running"
// session forever with no feedback. 10 minutes is generous for a real task
// while still bounding a truly stuck process.
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 10 * 60 * 1000);
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
const PERMISSION_RANK = { none: 0, read: 1, write: 2, admin: 3 };

async function checkGithubPermission(githubToken, repoPath, minPermission = "write") {
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
  if ((PERMISSION_RANK[permission] ?? 0) >= PERMISSION_RANK[minPermission]) {
    return { ok: true, username: user.login };
  }
  return {
    ok: false,
    reason: `${user.login} has "${permission}" access to ${parsed.owner}/${parsed.repo}; ${minPermission} access required`,
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

// repo path -> Set<ws> of read-only observers watching that repo's activity.
const observers = new Map();

function addObserver(repo, ws) {
  if (!observers.has(repo)) observers.set(repo, new Set());
  observers.get(repo).add(ws);
}

function removeObserver(repo, ws) {
  const set = observers.get(repo);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) observers.delete(repo);
}

// Sends to the controlling connection and mirrors the same message to every
// observer registered for that repo, so a live-watching connection sees
// exactly what the controller sees.
function broadcast(repo, msg, originWs) {
  send(originWs, msg);
  const set = observers.get(repo);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const obs of set) {
    if (obs !== originWs && obs.readyState === obs.OPEN) obs.send(payload);
  }
}

async function main() {
  await selectAgent();

  const wss = new WebSocketServer({ port: PORT });
  console.log(`Bridge listening on ws://localhost:${PORT}`);

  wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const githubToken = url.searchParams.get("githubToken");
  if (!githubToken) {
    ws.close(4001, "missing githubToken");
    return;
  }

  // Observers are read-only: they watch one repo's activity stream but can't
  // send instructions or approve/reject. Requires only read access, not write.
  if (url.searchParams.get("observer") === "true") {
    const repo = path.resolve(url.searchParams.get("repo") || "");
    if (!ALLOWED_REPOS.includes(repo)) {
      ws.close(4003, "repo not allowlisted");
      return;
    }
    checkGithubPermission(githubToken, repo, "read").then((check) => {
      if (!check.ok) {
        ws.close(4003, `not authorized: ${check.reason}`);
        return;
      }
      addObserver(repo, ws);
      send(ws, { type: "status", state: "observing" });
      ws.on("close", () => removeObserver(repo, ws));
    });
    return;
  }

  // Per-connection state: only one pending change-set at a time.
  let pending = null; // { repo, agentProc }

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

      if (!SELECTED_AGENT) {
        send(ws, {
          type: "error",
          message: "no usable agent CLI found on this machine; set AGENT_CMD in .env",
        });
        return;
      }

      broadcast(repo, { type: "status", state: "running" }, ws);

      const prompt =
        `${msg.text}\n\n` +
        `Make the necessary code changes in this repo. Do NOT run 'git commit' or 'git push' ` +
        `yourself — stop once the changes are made on disk.`;

      const agentProc = spawn(SELECTED_AGENT.cmd, SELECTED_AGENT.buildArgs(prompt), {
        cwd: repo,
      });
      pending = { repo, agentProc };

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        agentProc.kill();
        broadcast(
          repo,
          {
            type: "error",
            message: `${SELECTED_AGENT.label} timed out after ${Math.round(
              AGENT_TIMEOUT_MS / 1000
            )}s with no result — it may be stuck on an interactive prompt (e.g. a first-run login)`,
          },
          ws
        );
        pending = null;
        broadcast(repo, { type: "status", state: "idle" }, ws);
      }, AGENT_TIMEOUT_MS);

      // Known tools emit structured JSONL; turn it into concise lines rather
      // than forwarding raw text. Custom AGENT_CMD overrides have no known
      // schema, so they fall back to raw passthrough (SUMMARIZERS lookup
      // misses, summarize stays undefined).
      const summarize = SUMMARIZERS[SELECTED_AGENT.label];
      let lineBuffer = "";

      function handleOutput(d) {
        if (!summarize) {
          broadcast(repo, { type: "log", chunk: d.toString() }, ws);
          return;
        }
        lineBuffer += d.toString();
        let idx;
        while ((idx = lineBuffer.indexOf("\n")) !== -1) {
          const line = lineBuffer.slice(0, idx).trim();
          lineBuffer = lineBuffer.slice(idx + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            // Not JSON — e.g. a stray CLI warning outside the structured
            // stream. Surface it raw rather than risk silently dropping a
            // real error just because it didn't fit the expected schema.
            broadcast(repo, { type: "log", chunk: line + "\n" }, ws);
            continue;
          }
          const summary = summarize(ev);
          if (summary) broadcast(repo, { type: "log", chunk: summary + "\n" }, ws);
        }
      }

      agentProc.stdout.on("data", handleOutput);
      agentProc.stderr.on("data", handleOutput);
      let spawnFailed = false;
      agentProc.on("error", (e) => {
        clearTimeout(timeoutTimer);
        if (timedOut) return;
        spawnFailed = true;
        broadcast(
          repo,
          { type: "error", message: `failed to start ${SELECTED_AGENT.label}: ${e.message}` },
          ws
        );
        pending = null;
        broadcast(repo, { type: "status", state: "idle" }, ws);
      });

      agentProc.on("close", async (code) => {
        clearTimeout(timeoutTimer);
        if (spawnFailed || timedOut) return;
        if (code !== 0) {
          broadcast(
            repo,
            { type: "error", message: `${SELECTED_AGENT.label} exited with code ${code}` },
            ws
          );
          pending = null;
          broadcast(repo, { type: "status", state: "idle" }, ws);
          return;
        }

        try {
          const clean = await isTreeClean(repo);
          if (clean) {
            broadcast(repo, { type: "status", state: "no_changes" }, ws);
            pending = null;
            return;
          }

          await runGit(repo, ["add", "-A"]);
          const diff = await runGit(repo, ["diff", "--cached"]);
          broadcast(repo, { type: "diff", diff }, ws);
          broadcast(repo, { type: "status", state: "awaiting_approval" }, ws);
        } catch (e) {
          broadcast(repo, { type: "error", message: `post-run git failed: ${e.message}` }, ws);
          pending = null;
          broadcast(repo, { type: "status", state: "idle" }, ws);
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
        broadcast(repo, { type: "error", message: `not authorized: ${permCheck.reason}` }, ws);
        pending = null;
        broadcast(repo, { type: "status", state: "idle" }, ws);
        return;
      }

      try {
        await runGit(repo, ["commit", "-m", msg.message || "Changes via bridge"]);
        try {
          await runGit(repo, ["push"]);
          broadcast(repo, { type: "result", ok: true, detail: "committed and pushed" }, ws);
        } catch (pushErr) {
          broadcast(
            repo,
            {
              type: "result",
              ok: false,
              detail: `committed locally but push failed (a local commit now exists, unpushed): ${pushErr.message}`,
            },
            ws
          );
        }
      } catch (e) {
        broadcast(repo, { type: "result", ok: false, detail: e.message }, ws);
      } finally {
        pending = null;
        broadcast(repo, { type: "status", state: "idle" }, ws);
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
        broadcast(
          repo,
          { type: "result", ok: false, detail: `repo folder no longer exists on disk: ${repo}` },
          ws
        );
        pending = null;
        broadcast(repo, { type: "status", state: "idle" }, ws);
        return;
      }
      try {
        await runGit(repo, ["reset", "--hard", "HEAD"]);
        await runGit(repo, ["clean", "-fd"]);
        broadcast(repo, { type: "result", ok: true, detail: "discarded" }, ws);
      } catch (e) {
        broadcast(repo, { type: "result", ok: false, detail: e.message }, ws);
      } finally {
        pending = null;
        broadcast(repo, { type: "status", state: "idle" }, ws);
      }
      return;
    }

    send(ws, { type: "error", message: `unknown message type: ${msg.type}` });
  });

  ws.on("close", () => {
    // Note: an in-flight agent process for this connection keeps running
    // and the change-set is left pending; reconnect and approve/reject it.
  });
  });
}

main();
