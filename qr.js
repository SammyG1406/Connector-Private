require("dotenv").config({ quiet: true });
const path = require("path");
const QRCode = require("qrcode");
const { generateQR } = require("./qr-core");

const PORT = process.env.PORT || 8787;
const TUNNEL_ID = process.env.DEVTUNNEL_ID || "connector-bridge";
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((p) => p && path.resolve(p))
  .filter(Boolean);

if (ALLOWED_REPOS.length === 0) {
  console.error("ALLOWED_REPOS must be set in .env");
  process.exit(1);
}

generateQR({ port: PORT, tunnelId: TUNNEL_ID, repo: ALLOWED_REPOS[0] }).then(({ ws, repo, dataUrl }) => {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ws, repo, dataUrl }));
    return;
  }
  QRCode.toString(JSON.stringify({ ws, repo }), { type: "terminal", small: true }, (err, qr) => {
    if (err) throw err;
    console.log(qr);
    console.log(`ws:   ${ws}`);
    console.log(`repo: ${repo}`);
    console.log("\nScan with the bridge app. No secret is encoded — the app logs into");
    console.log("GitHub itself, and the bridge checks write access to this repo per instruction.");
  });
});
