require("dotenv").config({ quiet: true });
const QRCode = require("qrcode");
const path = require("path");
const { ensureTunnel } = require("./devtunnel-util");

const PORT = process.env.PORT || 8787;
const TUNNEL_ID = process.env.DEVTUNNEL_ID || "connector-bridge";
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((p) => p && path.resolve(p))
  .filter(Boolean);

if (!AUTH_TOKEN || ALLOWED_REPOS.length === 0) {
  console.error("AUTH_TOKEN and ALLOWED_REPOS must all be set in .env");
  process.exit(1);
}

const wsUrl = ensureTunnel(TUNNEL_ID, PORT);
const payload = JSON.stringify({
  ws: wsUrl,
  token: AUTH_TOKEN,
  repo: ALLOWED_REPOS[0],
});

if (process.argv.includes("--json")) {
  QRCode.toDataURL(payload, { width: 280 }, (err, dataUrl) => {
    if (err) throw err;
    console.log(JSON.stringify({ ws: wsUrl, token: AUTH_TOKEN, repo: ALLOWED_REPOS[0], dataUrl }));
  });
} else {
  QRCode.toString(payload, { type: "terminal", small: true }, (err, qr) => {
    if (err) throw err;
    console.log(qr);
    console.log(`ws:    ${wsUrl}`);
    console.log(`repo:  ${ALLOWED_REPOS[0]}`);
    console.log(`token: ${AUTH_TOKEN}`);
    console.log("\nScan with the bridge app to connect.");
  });
}
