const { execFileSync } = require("child_process");

function run(args) {
  return execFileSync("devtunnel", args, { encoding: "utf8" });
}

// Idempotent: creates the tunnel/port if missing, renews the 30-day expiration
// on every call so a tunnel that's started regularly never actually lapses.
// Returns the stable wss:// URL for the given port.
function ensureTunnel(tunnelId, port) {
  try {
    run(["show", tunnelId, "--json"]);
  } catch {
    run(["create", tunnelId, "--allow-anonymous", "--json"]);
  }
  run(["update", tunnelId, "--expiration", "30d", "--json"]);

  let info = JSON.parse(run(["show", tunnelId, "--json"]));
  const hasPort = (info.tunnel.ports || []).some((p) => p.portNumber === Number(port));
  if (!hasPort) {
    run(["port", "create", tunnelId, "-p", String(port), "--protocol", "http", "--json"]);
    info = JSON.parse(run(["show", tunnelId, "--json"]));
  }

  const portInfo = info.tunnel.ports.find((p) => p.portNumber === Number(port));
  return portInfo.portUri.replace(/\/$/, "").replace(/^https:/, "wss:");
}

module.exports = { ensureTunnel };
