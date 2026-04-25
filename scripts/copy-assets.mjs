import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const src = "cli/template.html";
const dest = "dist/cli/template.html";
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied ${src} -> ${dest}`);
