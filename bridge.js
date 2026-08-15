// CLI entry point: reads .env, delegates to bridge-core. See bridge-core.js
// for the actual server implementation and the wire protocol docs.
require("dotenv").config({ quiet: true });
const path = require("path");
const { startBridgeServer } = require("./bridge-core");

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled rejection]", e));

const allowedRepos = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((p) => p && path.resolve(p))
  .filter(Boolean);

if (allowedRepos.length === 0) {
  console.error("ALLOWED_REPOS env var is required (comma-separated absolute paths)");
  process.exit(1);
}

const config = {
  port: process.env.PORT,
  allowedRepos,
  agentCmd: process.env.AGENT_CMD,
  agentArgsTemplate: process.env.AGENT_ARGS,
  agentPriority: process.env.AGENT_PRIORITY,
  agentTimeoutMs: process.env.AGENT_TIMEOUT_MS,
  preventSleep: process.env.PREVENT_SLEEP !== "false",
};

startBridgeServer(config, { log: console.log })
  .then(({ stop }) => {
    process.on("exit", stop);
    process.on("SIGINT", () => {
      stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      stop();
      process.exit(0);
    });
  })
  .catch((e) => {
    console.error(`[bridge] failed to start: ${e.message}`);
    process.exit(1);
  });
