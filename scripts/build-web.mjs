import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const outdir = "web/dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

function copyDirShallow(srcDir, destDir) {
  let copied = 0;
  try {
    const entries = readdirSync(srcDir);
    if (entries.length === 0) return 0;
    mkdirSync(destDir, { recursive: true });
    for (const name of entries) {
      const src = join(srcDir, name);
      const dest = join(destDir, name);
      if (statSync(src).isFile()) {
        copyFileSync(src, dest);
        copied += 1;
      }
    }
  } catch {
    // src dir doesn't exist — fine, screenshots are optional
  }
  return copied;
}

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

// Ship screenshots so the OG image + preview thumbnails resolve on the
// deployed site. Skips silently if web/screenshots/ doesn't exist.
const shotCount = copyDirShallow("web/screenshots", `${outdir}/screenshots`);

console.log(
  `bundle ready: ${outdir}/{index.html,main.js}` +
    (shotCount > 0 ? ` + ${shotCount} screenshots` : ""),
);
