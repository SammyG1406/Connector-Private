require("dotenv").config();
const QRCode = require("qrcode");
const path = require("path");

const NGROK_DOMAIN = process.env.NGROK_DOMAIN;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((p) => p && path.resolve(p))
  .filter(Boolean);

if (!NGROK_DOMAIN || !AUTH_TOKEN || ALLOWED_REPOS.length === 0) {
  console.error("NGROK_DOMAIN, AUTH_TOKEN, and ALLOWED_REPOS must all be set in .env");
  process.exit(1);
}

const payload = JSON.stringify({
  ws: `wss://${NGROK_DOMAIN}`,
  token: AUTH_TOKEN,
  repo: ALLOWED_REPOS[0],
});

QRCode.toString(payload, { type: "terminal", small: true }, (err, qr) => {
  if (err) throw err;
  console.log(qr);
  console.log(`ws:    wss://${NGROK_DOMAIN}`);
  console.log(`repo:  ${ALLOWED_REPOS[0]}`);
  console.log(`token: ${AUTH_TOKEN}`);
  console.log("\nScan with the bridge app to connect. Valid as long as the token and domain don't change.");
});
