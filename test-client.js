// Manual smoke-test client for bridge.js
// Usage: node test-client.js <ws-url-with-token> <repo-path> <instruction text...>
const WebSocket = require("ws");
const readline = require("readline");

const [, , wsUrl, repo, ...rest] = process.argv;
if (!wsUrl || !repo || rest.length === 0) {
  console.error("Usage: node test-client.js <ws-url-with-token> <repo-path> <instruction text>");
  process.exit(1);
}
const text = rest.join(" ");

console.log(`[connecting] ${wsUrl}`);
const ws = new WebSocket(wsUrl);

ws.on("open", () => {
  console.log("[connected] sending instruction...");
  ws.send(JSON.stringify({ type: "instruction", repo, text }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "log") {
    process.stdout.write(msg.chunk);
  } else if (msg.type === "status") {
    console.log(`\n[status] ${msg.state}`);
  } else if (msg.type === "diff") {
    console.log("\n----- DIFF -----");
    console.log(msg.diff);
    console.log("----------------");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("approve or reject? ", (answer) => {
      rl.close();
      if (answer.trim().toLowerCase().startsWith("a")) {
        ws.send(JSON.stringify({ type: "approve", message: "bridge smoke test" }));
      } else {
        ws.send(JSON.stringify({ type: "reject" }));
      }
    });
  } else if (msg.type === "result") {
    console.log(`\n[result] ok=${msg.ok} detail=${msg.detail}`);
  } else if (msg.type === "error") {
    console.error(`\n[error] ${msg.message}`);
  }
});

ws.on("close", (code, reason) => {
  console.log(`\n[closed] code=${code} reason=${reason}`);
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`[ws error] ${err.message}`);
});
