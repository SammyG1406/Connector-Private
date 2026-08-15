// Bridge: phone <-> WebSocket <-> agent CLI (headless) <-> git
//
// This module is the extracted core of the bridge server, parameterized so
// it can be driven either by the root CLI (bridge.js, config from .env) or
// by the VS Code extension (config from workspace settings + open folders).
// No behavior here differs from the original script — only where config
// values and log output come from.
//
// Connect with ?githubToken=<GitHub OAuth token>. Authorization isn't a
// shared secret — each instruction is checked against GitHub's own
// collaborator-permission API for the target repo (write/admin required).
//
// Which agent CLI runs instructions is auto-detected at startup: tries
// claude, copilot, codex (in that order, see config.agentPriority) and uses
// whichever is actually installed. Override entirely with config.agentCmd
// (plus optional config.agentArgsTemplate, a template using {prompt}) to
// point at anything else.
//
// Controller protocol (client -> server):
//   {type:"instruction", repo:"/abs/path", text:"..."}
//   {type:"answer", value:"..."}       -- reply to a pending "question" log event
//   {type:"approve", message:"commit message"}
//   {type:"reject"}
//
// Server -> client (both controllers and observers receive these):
//   {type:"status", state:"running"|"awaiting_answer"|"awaiting_approval"|"no_changes"|"idle"|"observing"}
//   {type:"log", kind:"tool_call"|"message"|"question"|"error"|"done"|"raw", text:"...",
//                tool:"...", target:"...", options:[...]}
//     - tool/target only present on kind:"tool_call"; options only on kind:"question"
//     - kind:"question" means the agent is paused awaiting an {type:"answer"} reply
//       (see OPTIONS convention in AGENT_PROMPT_SUFFIX below — this is not a
//       feature any of the three tools have natively; it's a text convention
//       we impose via the prompt and parse out of their plain-text replies)
//   {type:"diff", diff:"..."}
//   {type:"result", ok:true|false, detail:"..."}
//   {type:"error", message:"..."}
//
// Observer mode: connect with ?observer=true&repo=/abs/path (in addition to
// githubToken). Read-only — requires only read access to the repo, not
// write — and receives the same status/log/diff/result stream a controller
// working on that repo sees, without being able to send instructions or
// approve/reject.

const { WebSocketServer } = require("ws");
const spawn = require("cross-spawn");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

// None of claude/copilot/codex have a native "pause and ask the user to pick
// one of a few options" mechanism in headless mode — verified directly: asked
// claude an intentionally ambiguous question, and it just answered in plain
// text and exited normally, same as any other finished turn. So this is a
// convention WE define via the prompt (see AGENT_PROMPT_SUFFIX) and parse out
// of whatever plain text a turn ends with, uniformly across all three tools.
function parseOptionsMarker(text) {
  const m = text.match(/OPTIONS:\s*(\[[\s\S]*\])\s*$/);
  if (!m) return null;
  try {
    const options = JSON.parse(m[1]);
    if (!Array.isArray(options) || options.length === 0) return null;
    return { text: text.slice(0, m.index).trim() || "Choose an option:", options };
  } catch {
    return null;
  }
}

// Each summarizer takes one parsed JSONL event from a tool's structured
// output mode and returns either an array of structured {kind, text, ...}
// events (kind: "tool_call" | "message" | "question" | "error" | "done") or
// null to skip it entirely. No raw code/diffs/tool payloads — those stay in
// the separate "diff" message sent at approval time. Built from real event
// streams captured against actual installs on this machine — not guessed —
// except where noted.

// Verified against a real successful run (file write + read-back) and a real
// question-asking run (see parseOptionsMarker comment above).
function summarizeClaudeEvent(ev) {
  if (ev.type === "assistant" && ev.message?.content) {
    const items = [];
    for (const block of ev.message.content) {
      if (block.type === "tool_use") {
        const target = block.input?.file_path || block.input?.command || block.input?.pattern || "";
        items.push({
          kind: "tool_call",
          tool: block.name,
          ...(target ? { target: truncate(target) } : {}),
          text: `${block.name}${target ? `: ${truncate(target)}` : ""}`,
        });
      } else if (block.type === "text" && block.text?.trim()) {
        const parsed = parseOptionsMarker(block.text);
        items.push(
          parsed
            ? { kind: "question", text: parsed.text, options: parsed.options }
            : { kind: "message", text: truncate(block.text, 200) }
        );
      }
    }
    return items.length ? items : null;
  }
  if (ev.type === "user" && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return [{ kind: "error", text: truncate(text, 200) }];
      }
    }
    return null;
  }
  if (ev.type === "result") {
    return ev.is_error
      ? [{ kind: "error", text: truncate(ev.result || "unknown error", 200) }]
      : [{ kind: "done", text: "Done" }];
  }
  return null;
}

// Verified against a real successful run (file write + read-back).
function summarizeCopilotEvent(ev) {
  if (ev.ephemeral === true) return null;
  if (ev.type === "tool.execution_start") {
    const a = ev.data?.arguments || {};
    const target = a.path || a.command || a.query || "";
    return [
      {
        kind: "tool_call",
        tool: ev.data?.toolName,
        ...(target ? { target: truncate(target) } : {}),
        text: `${ev.data?.toolName}${target ? `: ${truncate(target)}` : ""}`,
      },
    ];
  }
  if (ev.type === "tool.execution_complete") {
    if (ev.data?.success === false) {
      return [{ kind: "error", text: truncate(ev.data?.result?.content || "tool failed", 200) }];
    }
    return null; // tool_start already announced it; skip the (verbose) completion payload
  }
  if (ev.type === "assistant.message" && ev.data?.content?.trim()) {
    const parsed = parseOptionsMarker(ev.data.content);
    return [
      parsed
        ? { kind: "question", text: parsed.text, options: parsed.options }
        : { kind: "message", text: truncate(ev.data.content, 200) },
    ];
  }
  if (ev.type === "result") {
    return ev.exitCode === 0
      ? [{ kind: "done", text: "Done" }]
      : [{ kind: "error", text: `Failed (exit ${ev.exitCode})` }];
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
  if (ev.type === "error") return [{ kind: "error", text: truncate(ev.message, 200) }];
  if (ev.type === "turn.failed") {
    return [{ kind: "error", text: truncate(ev.error?.message || "unknown error", 200) }];
  }
  if (ev.type === "item.completed" && ev.item) {
    const item = ev.item;
    if (item.type === "error") return [{ kind: "error", text: truncate(item.message, 200) }];
    if (item.type === "agent_message" && item.text) {
      const parsed = parseOptionsMarker(item.text);
      return [
        parsed
          ? { kind: "question", text: parsed.text, options: parsed.options }
          : { kind: "message", text: truncate(item.text, 200) },
      ];
    }
    if (item.type === "command_execution" && item.command) {
      return [
        {
          kind: "tool_call",
          tool: "command_execution",
          target: truncate(item.command, 150),
          text: `Running: ${truncate(item.command, 150)}`,
        },
      ];
    }
    if (item.type === "file_change" && item.path) {
      return [
        {
          kind: "tool_call",
          tool: "file_change",
          target: truncate(item.path, 150),
          text: `Editing: ${truncate(item.path, 150)}`,
        },
      ];
    }
    return [{ kind: "tool_call", tool: item.type || "step", text: `${item.type || "step"} completed` }];
  }
  if (ev.type === "turn.completed" || ev.type === "thread.completed") return [{ kind: "done", text: "Done" }];
  return null;
}

const SUMMARIZERS = {
  claude: summarizeClaudeEvent,
  copilot: summarizeCopilotEvent,
  codex: summarizeCodexEvent,
};

// Known agent CLIs, tried in priority order (config.agentPriority) at
// startup — first one that's actually installed wins. Each buildArgs(prompt)
// returns the args for a fresh, non-interactive, no-confirmation-prompts
// run, using each tool's structured JSONL output mode so summarizeXEvent()
// above can turn it into concise lines instead of forwarding raw text.
// Flags verified directly against each tool's --help, not guessed.
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

// Parses "https://github.com/owner/repo.git" or "git@github.com:owner/repo.git"
function parseGithubRemote(remoteUrl) {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

const PERMISSION_RANK = { none: 0, read: 1, write: 2, admin: 3 };

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

/**
 * @param {object} config
 * @param {number} [config.port=8787]
 * @param {string[]} config.allowedRepos - resolved absolute paths
 * @param {string} [config.agentCmd] - override, skips auto-detection
 * @param {string} [config.agentArgsTemplate] - template string, {prompt} placeholder
 * @param {string} [config.agentPriority="claude,copilot,codex"] - comma-separated
 * @param {number} [config.agentTimeoutMs=600000]
 * @param {boolean} [config.preventSleep=true] - Windows only
 * @param {string} [config.keepAwakeScriptPath] - defaults to keep-awake.ps1 next to this file
 * @param {{ log?: (msg: string) => void }} [handlers]
 * @returns {Promise<{ stop: () => void }>} resolves once the server is listening
 */
function startBridgeServer(config, handlers = {}) {
  const log = handlers.log || (() => {});

  const port = Number(config.port || 8787);
  const allowedRepos = config.allowedRepos || [];
  if (allowedRepos.length === 0) {
    return Promise.reject(new Error("allowedRepos is required (at least one absolute repo path)"));
  }

  const agentCmdOverride = config.agentCmd;
  const agentArgsOverride = config.agentArgsTemplate;
  const agentPriority = (config.agentPriority || "claude,copilot,codex")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const agentTimeoutMs = Number(config.agentTimeoutMs || 10 * 60 * 1000);
  const preventSleep = config.preventSleep !== false;
  const keepAwakeScriptPath = config.keepAwakeScriptPath || path.join(__dirname, "keep-awake.ps1");

  // Appended to every prompt, including follow-ups after an answered question.
  // The OPTIONS convention is ours, not any tool's — see parseOptionsMarker.
  const AGENT_PROMPT_SUFFIX =
    `\n\nMake the necessary code changes in this repo. Do NOT run 'git commit' or 'git push' ` +
    `yourself — stop once the changes are made on disk.\n\n` +
    `If you need the user to choose between a small number of options before proceeding, ` +
    `don't guess — end your reply with exactly one line formatted:\n` +
    `OPTIONS: ["Option A description", "Option B description", ...]\n` +
    `Don't make any file changes yet if you're asking — wait for the user's choice.`;

  // Authorization is delegated to GitHub itself: the presented token must belong
  // to an account with write (or admin) access to the specific repo being
  // targeted. This replaces a shared bearer secret with a real identity check —
  // a leaked QR code is useless without a GitHub account GitHub itself vouches
  // for on this repo.
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

  let selectedAgent = null; // { label, cmd, buildArgs }

  async function selectAgent() {
    if (agentCmdOverride) {
      const template = agentArgsOverride || "-p {prompt} --dangerously-skip-permissions";
      const resolved = resolveAgentCommand(agentCmdOverride);
      const buildArgs = (prompt) => [
        ...resolved.prefixArgs,
        ...template.split(" ").map((tok) => (tok === "{prompt}" ? prompt : tok)),
      ];
      const ok = await checkCommandAvailable(resolved.cmd, [...resolved.prefixArgs, "--version"]);
      if (!ok) {
        log(
          `[agent] agentCmd="${agentCmdOverride}" does not appear to be usable ` +
            `(checked --version). Instructions will fail until this is fixed.`
        );
      } else {
        log(`[agent] using "${agentCmdOverride}" (from agentCmd)`);
      }
      selectedAgent = { label: agentCmdOverride, cmd: resolved.cmd, buildArgs };
      return;
    }

    for (const name of agentPriority) {
      const known = KNOWN_AGENTS[name];
      if (!known) continue;
      const resolved = resolveAgentCommand(known.cmd);
      const ok = await checkCommandAvailable(resolved.cmd, [
        ...resolved.prefixArgs,
        ...known.versionArgs,
      ]);
      if (ok) {
        selectedAgent = {
          label: name,
          cmd: resolved.cmd,
          buildArgs: (prompt) => [...resolved.prefixArgs, ...known.buildArgs(prompt)],
        };
        log(`[agent] using "${name}"`);
        return;
      }
    }

    log(
      `[agent] none of the known tools (${agentPriority.join(", ")}) were found. ` +
        `Set agentCmd to point at whichever CLI you have installed. ` +
        `Instructions will fail with a clear error until this is fixed.`
    );
  }

  // Windows idle-sleep would suspend the bridge, the tunnel, and any in-flight
  // agent process without warning, and severs every open connection. Rather
  // than requiring a machine-wide "never sleep" power setting, hold Windows'
  // own SetThreadExecutionState(ES_SYSTEM_REQUIRED) for exactly as long as the
  // bridge is running — via a small PowerShell helper, since that avoids any
  // native Node addon/compilation step. This only suppresses idle-timeout
  // sleep; it does NOT override an explicit lid-close or manual sleep action
  // (those are separate Windows power settings). Opt out with preventSleep:false.
  let keepAwakeProc = null;

  function startKeepAwake() {
    if (process.platform !== "win32") return;
    if (!preventSleep) return;
    keepAwakeProc = spawn(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        keepAwakeScriptPath,
        "-ParentPid",
        String(process.pid),
      ],
      { windowsHide: true }
    );
    keepAwakeProc.on("error", (e) => {
      log(`[keep-awake] failed to start: ${e.message}`);
      keepAwakeProc = null;
    });
    keepAwakeProc.stdout.on("data", (d) => log(`[keep-awake] ${d.toString().trim()}`));
    keepAwakeProc.stderr.on("data", (d) => log(`[keep-awake] ${d.toString().trim()}`));
  }

  function stopKeepAwake() {
    if (keepAwakeProc) {
      keepAwakeProc.kill();
      keepAwakeProc = null;
    }
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

  return new Promise((resolve, reject) => {
    startKeepAwake();

    selectAgent().then(() => {
      const wss = new WebSocketServer({ port });

      wss.on("error", (e) => {
        stopKeepAwake();
        reject(e);
      });

      wss.on("listening", () => {
        log(`Bridge listening on ws://localhost:${port}`);

        resolve({
          stop() {
            stopKeepAwake();
            wss.close();
          },
        });
      });

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
          if (!allowedRepos.includes(repo)) {
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
        let pending = null; // { repo, agentProc, awaitingAnswer }

        // Shared by "instruction" (fresh prompt) and "answer" (follow-up prompt
        // after a question) — both just start an agent turn against the same repo
        // and wire up the same output/timeout/completion handling.
        function runAgentTurn(repo, prompt, ws) {
          broadcast(repo, { type: "status", state: "running" }, ws);

          const agentProc = spawn(selectedAgent.cmd, selectedAgent.buildArgs(prompt), { cwd: repo });
          pending = { repo, agentProc, awaitingAnswer: false };

          // A client can answer a question as soon as it sees the "question" log
          // event — which happens while this process is still winding down, not
          // necessarily after it has actually exited. That starts a NEW agentProc
          // and reassigns `pending` before this one is done flushing output or
          // has fired "close". Verified this race directly with a fast-answering
          // test client: this process's trailing output and its close handler
          // both fired after the new turn had already started, corrupting its
          // state and leaking a stale "done" through right after "running".
          // Every use of shared `pending` state below must check this first.
          const owns = () => pending?.agentProc === agentProc;

          let timedOut = false;
          const timeoutTimer = setTimeout(() => {
            timedOut = true;
            agentProc.kill();
            broadcast(
              repo,
              {
                type: "error",
                message: `${selectedAgent.label} timed out after ${Math.round(
                  agentTimeoutMs / 1000
                )}s with no result — it may be stuck on an interactive prompt (e.g. a first-run login)`,
              },
              ws
            );
            if (owns()) pending = null;
            broadcast(repo, { type: "status", state: "idle" }, ws);
          }, agentTimeoutMs);

          // Known tools emit structured JSONL; turn it into concise structured
          // events rather than forwarding raw text. Custom agentCmd overrides
          // have no known schema, so they fall back to raw passthrough
          // (SUMMARIZERS lookup misses, summarize stays undefined).
          const summarize = SUMMARIZERS[selectedAgent.label];
          let lineBuffer = "";

          function handleOutput(d) {
            if (!owns()) return; // superseded by a newer turn — drop trailing output
            if (!summarize) {
              broadcast(repo, { type: "log", kind: "raw", text: d.toString() }, ws);
              return;
            }
            lineBuffer += d.toString();
            let idx;
            while ((idx = lineBuffer.indexOf("\n")) !== -1) {
              const line = lineBuffer.slice(0, idx).trim();
              lineBuffer = lineBuffer.slice(idx + 1);
              if (!line) continue;
              if (!owns()) return; // could have been superseded mid-loop too
              let ev;
              try {
                ev = JSON.parse(line);
              } catch {
                // Not JSON — e.g. a stray CLI warning outside the structured
                // stream. Surface it raw rather than risk silently dropping a
                // real error just because it didn't fit the expected schema.
                broadcast(repo, { type: "log", kind: "raw", text: line }, ws);
                continue;
              }
              const items = summarize(ev);
              if (!items) continue;
              for (const item of items) {
                if (item.kind === "question") pending.awaitingAnswer = true;
                // A tool's own "done" fires right after it answers a question too
                // (it doesn't know about our OPTIONS convention) — suppress it so
                // the phone doesn't see "done" immediately after "please choose."
                if (item.kind === "done" && pending.awaitingAnswer) continue;
                broadcast(repo, { type: "log", ...item }, ws);
              }
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
              { type: "error", message: `failed to start ${selectedAgent.label}: ${e.message}` },
              ws
            );
            if (owns()) pending = null;
            broadcast(repo, { type: "status", state: "idle" }, ws);
          });

          agentProc.on("close", async (code) => {
            clearTimeout(timeoutTimer);
            if (spawnFailed || timedOut) return;
            if (code !== 0) {
              broadcast(
                repo,
                { type: "error", message: `${selectedAgent.label} exited with code ${code}` },
                ws
              );
              if (owns()) pending = null;
              broadcast(repo, { type: "status", state: "idle" }, ws);
              return;
            }

            if (!owns()) {
              // A newer turn already took over (see comment above) — this one's
              // outcome is moot, and touching `pending`/status now would corrupt
              // whatever the newer turn is doing.
              return;
            }

            if (pending.awaitingAnswer) {
              // Not finished — genuinely paused. Keep `pending` so an "answer"
              // message can resume this same turn via --continue.
              broadcast(repo, { type: "status", state: "awaiting_answer" }, ws);
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
        }

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
            if (!allowedRepos.includes(repo)) {
              send(ws, { type: "error", message: `repo not allowlisted: ${repo}` });
              return;
            }

            const permCheck = await checkGithubPermission(githubToken, repo);
            if (!permCheck.ok) {
              send(ws, { type: "error", message: `not authorized: ${permCheck.reason}` });
              return;
            }

            if (!selectedAgent) {
              send(ws, {
                type: "error",
                message: "no usable agent CLI found on this machine; set agentCmd in settings",
              });
              return;
            }

            runAgentTurn(repo, `${msg.text}${AGENT_PROMPT_SUFFIX}`, ws);
            return;
          }

          if (msg.type === "answer") {
            if (!pending || !pending.awaitingAnswer) {
              send(ws, { type: "error", message: "nothing awaiting an answer" });
              return;
            }
            const { repo } = pending;
            runAgentTurn(repo, `The user chose: "${msg.value}". Proceed accordingly.${AGENT_PROMPT_SUFFIX}`, ws);
            return;
          }

          if (msg.type === "approve") {
            if (!pending) {
              send(ws, { type: "error", message: "nothing pending" });
              return;
            }
            if (pending.awaitingAnswer) {
              send(ws, { type: "error", message: "an answer is required before this can be approved" });
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
            if (pending.awaitingAnswer) {
              // No diff exists yet to discard — treat this as cancelling the
              // pending question instead, since there's otherwise no way to back
              // out of an unwanted question flow.
              const awaitingRepo = pending.repo;
              pending = null;
              broadcast(awaitingRepo, { type: "result", ok: true, detail: "cancelled" }, ws);
              broadcast(awaitingRepo, { type: "status", state: "idle" }, ws);
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
    });
  });
}

module.exports = { startBridgeServer };
