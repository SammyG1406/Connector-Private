require("dotenv").config({ quiet: true });
const { startTunnelHost } = require("./tunnel-core");

const PORT = process.env.PORT || 8787;
const TUNNEL_ID = process.env.DEVTUNNEL_ID || "connector-bridge";

const { wsUrl, process: proc } = startTunnelHost({ tunnelId: TUNNEL_ID, port: PORT, stdio: "inherit" });
console.log(`Public URL: ${wsUrl}`);

proc.on("exit", (code) => process.exit(code ?? 0));
