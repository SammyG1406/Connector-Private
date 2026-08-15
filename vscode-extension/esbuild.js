const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "extension.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    outfile: path.join(__dirname, "dist", "extension.js"),
    sourcemap: true,
  });

  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "..", "keep-awake.ps1"),
    path.join(__dirname, "dist", "keep-awake.ps1")
  );

  console.log("Build complete: dist/extension.js");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
