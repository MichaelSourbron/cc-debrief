import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const REPORT = process.argv[2] ?? "C:/repo/attribution-view/report-i2insights.html";
const OUT = resolve("web/screenshots");
mkdirSync(OUT, { recursive: true });

const candidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const fs = await import("node:fs");
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error("Could not find Edge or Chrome. Install one and retry.");
  process.exit(1);
}
console.log("Using browser:", exe);

const browser = await puppeteer.launch({ executablePath: exe, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
await page.goto(`file:///${REPORT.replace(/\\/g, "/")}`, { waitUntil: "networkidle0" });
// ECharts needs a tick after networkidle to finish drawing.
await new Promise((r) => setTimeout(r, 2500));

// Open every <details> so its body and chart are visible to capture.
await page.evaluate(() => {
  document.querySelectorAll("details").forEach((d) => (d.open = true));
});
await new Promise((r) => setTimeout(r, 1500));

// Section IDs from the report layout.
const sections = [
  ["hero", "01-hero"],
  ["stats", "02-stats"],
  ["insights", "03-insights"],
  ["recs", "04-recs"],
  ["top-turns", "05-top-turns"],
  ["treemap", "06-treemap"],
  ["waste", "07-waste"],
  ["tools", "08-tools"],
  ["idle", "09-idle"],
  ["attribution", "10-attribution"],
  ["tokens", "11-tokens"],
  ["cost", "12-cost"],
];

for (const [id, fileLabel] of sections) {
  const handle = await page.$(`#${id}`);
  if (!handle) {
    console.warn(`skip: #${id} not found`);
    continue;
  }
  await handle.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "start" }));
  // Trigger any chart resize that's gated on visibility.
  await page.evaluate(() => {
    const echarts = window.echarts;
    if (!echarts) return;
    document.querySelectorAll(".chart").forEach((el) => {
      const inst = echarts.getInstanceByDom(el);
      if (inst) inst.resize();
    });
  });
  await new Promise((r) => setTimeout(r, 600));
  const out = `${OUT}/${fileLabel}.png`;
  await handle.screenshot({ path: out });
  console.log("wrote", out);
}

await browser.close();
console.log(`Done — ${sections.length} screenshots in ${OUT}`);
