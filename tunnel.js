require("dotenv").config({ quiet: true });
const spawn = require("cross-spawn");
const { ensureTunnel } = require("./devtunnel-util");

const PORT = process.env.PORT || 8787;
const TUNNEL_ID = process.env.DEVTUNNEL_ID || "connector-bridge";

const wsUrl = ensureTunnel(TUNNEL_ID, PORT);
console.log(`Public URL: ${wsUrl}`);

const proc = spawn("devtunnel", ["host", TUNNEL_ID], { stdio: "inherit" });
proc.on("exit", (code) => process.exit(code ?? 0));
