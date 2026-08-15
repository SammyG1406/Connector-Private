const spawn = require("cross-spawn");
const { ensureTunnel } = require("./devtunnel-util");

/**
 * Provisions (or renews) the devtunnel and spawns `devtunnel host` to
 * actually forward traffic to it. The forwarding process runs until
 * `stop()` is called or it exits on its own.
 *
 * @param {object} config
 * @param {string} config.tunnelId
 * @param {number} config.port
 * @param {"inherit"|"pipe"} [config.stdio="inherit"]
 * @returns {{ process: import("child_process").ChildProcess, wsUrl: string, stop: () => void }}
 */
function startTunnelHost(config) {
  const { tunnelId, port, stdio = "inherit" } = config;
  const wsUrl = ensureTunnel(tunnelId, port);

  const proc = spawn("devtunnel", ["host", tunnelId], { stdio });

  return {
    process: proc,
    wsUrl,
    stop() {
      proc.kill();
    },
  };
}

module.exports = { startTunnelHost };
