import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const outdir = "web/dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// IIFE format so the bundle loads from file:// too (ES modules over file://
// are blocked by all major browsers). Same size; no DX difference.
await build({
  entryPoints: ["web/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: `${outdir}/main.js`,
  minify: true,
  sourcemap: false,
  logLevel: "info",
});

copyFileSync("web/index.html", `${outdir}/index.html`);
console.log(`bundle ready: ${outdir}/{index.html,main.js}`);
