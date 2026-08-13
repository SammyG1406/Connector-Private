require("dotenv").config({ quiet: true });
const QRCode = require("qrcode");
const path = require("path");
const { ensureTunnel } = require("./devtunnel-util");

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

const wsUrl = ensureTunnel(TUNNEL_ID, PORT);
const payload = JSON.stringify({
  ws: wsUrl,
  repo: ALLOWED_REPOS[0],
});

if (process.argv.includes("--json")) {
  QRCode.toDataURL(payload, { width: 280 }, (err, dataUrl) => {
    if (err) throw err;
    console.log(JSON.stringify({ ws: wsUrl, repo: ALLOWED_REPOS[0], dataUrl }));
  });
} else {
  QRCode.toString(payload, { type: "terminal", small: true }, (err, qr) => {
    if (err) throw err;
    console.log(qr);
    console.log(`ws:   ${wsUrl}`);
    console.log(`repo: ${ALLOWED_REPOS[0]}`);
    console.log("\nScan with the bridge app. No secret is encoded — the app logs into");
    console.log("GitHub itself, and the bridge checks write access to this repo per instruction.");
  });
}
