require("dotenv").config();
const spawn = require("cross-spawn");

const PORT = process.env.PORT || 8787;
const NGROK_DOMAIN = process.env.NGROK_DOMAIN;

if (!NGROK_DOMAIN) {
  console.error("NGROK_DOMAIN env var is required");
  process.exit(1);
}

const proc = spawn("ngrok", ["http", String(PORT), "--url", `https://${NGROK_DOMAIN}`], {
  stdio: "inherit",
});
proc.on("exit", (code) => process.exit(code ?? 0));
