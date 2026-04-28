// Markdown table → PNG renderer.
//
// Medium's editor mangles markdown tables on paste, so this script extracts
// every table from a source markdown file, renders each one as a standalone
// HTML page styled with cc-debrief's dark palette, and captures a 2× PNG via
// Puppeteer. Resulting images go in articles/images/ and can be uploaded
// directly to Medium (or any other platform that doesn't preserve markdown
// tables).
//
// Usage:
//   node scripts/render-tables.mjs [source.md]
// Default source: articles/03-used-insights-as-spec.md

import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

const SOURCE = resolve(process.argv[2] ?? "articles/03-used-insights-as-spec.md");
const OUT = resolve("articles/images");

if (!existsSync(SOURCE)) {
  console.error(`source not found: ${SOURCE}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
// Clear stale images so the table-NN numbering stays sane after edits.
for (const f of readdirSync(OUT)) {
  if (/^table-\d+\.png$/.test(f)) rmSync(resolve(OUT, f));
}

// -- 1. Parse markdown: find every table block ---------------------------
//
// A table block is:
//   |  header  |  header  |
//   |---|---|         (separator: pipes + dashes/colons/spaces)
//   |  cell  |  cell  |
//   ...
// Continues until a non-pipe-prefixed line.

const text = readFileSync(SOURCE, "utf8");
const lines = text.split(/\r?\n/);

const tables = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i].trim();
  const next = (lines[i + 1] ?? "").trim();
  const isHeader = line.startsWith("|") && line.endsWith("|");
  const isSeparator = /^\|[\s\-:|]+\|$/.test(next);
  if (isHeader && isSeparator) {
    const start = i;
    const block = [lines[i], lines[i + 1]];
    i += 2;
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      block.push(lines[i]);
      i += 1;
    }
    // Capture the nearest preceding heading for context (best-effort caption).
    let caption = "";
    for (let j = start - 1; j >= 0; j--) {
      const m = lines[j].match(/^(#{1,4})\s+(.+?)\s*$/);
      if (m) {
        caption = m[2].trim();
        break;
      }
      if (lines[j].trim().startsWith("|")) break; // hit another table; stop
    }
    tables.push({ markdown: block.join("\n"), caption, lineNumber: start + 1 });
  } else {
    i += 1;
  }
}

console.log(`Parsed ${tables.length} tables from ${basename(SOURCE)}`);

// -- 2. Markdown → table HTML ---------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMd(s) {
  // Order matters: code (greedy) before bold/italic so we don't munge `code`.
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, t) => `<code>${t}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`);
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => `<em>${t}</em>`);
  return out;
}

function tableMdToHtml(md) {
  const rows = md.trim().split(/\r?\n/).filter((r) => r.trim().startsWith("|"));
  const splitRow = (row) => {
    // Strip leading + trailing pipes, split on remaining pipes (no escape support).
    const stripped = row.trim().replace(/^\|/, "").replace(/\|$/, "");
    return stripped.split("|").map((c) => c.trim());
  };
  const headerCells = splitRow(rows[0]);
  // rows[1] is the separator — skip
  const bodyRows = rows.slice(2).map(splitRow);

  const thead =
    "<thead><tr>" +
    headerCells.map((h) => `<th>${inlineMd(h)}</th>`).join("") +
    "</tr></thead>";
  const tbody =
    "<tbody>" +
    bodyRows
      .map(
        (cells) =>
          "<tr>" +
          cells.map((c, idx) => {
            const html = inlineMd(c);
            // First column gets the "label" treatment (slightly different colour).
            const cls = idx === 0 ? ' class="label"' : "";
            return `<td${cls}>${html}</td>`;
          }).join("") +
          "</tr>",
      )
      .join("") +
    "</tbody>";
  return `<table>${thead}${tbody}</table>`;
}

// -- 3. HTML page template (cc-debrief palette) ---------------------------

function pageHtml(tableHtml, caption) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --border: #30363d;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --accent2: #d2a8ff;
    --good: #3fb950;
    --warn: #d29922;
    --bad: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 40px;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .wrap {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px 28px 22px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
    max-width: 1120px;
  }
  .caption {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 14px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-variant-numeric: tabular-nums;
  }
  th, td {
    padding: 11px 14px;
    text-align: left;
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    border-bottom: 1px solid #21262d;
    color: #c9d1d9;
    font-size: 13.5px;
  }
  td.label {
    color: var(--fg);
    font-weight: 500;
    white-space: normal;
  }
  tr:last-child td { border-bottom: none; }
  code {
    background: #1c2128;
    color: var(--accent);
    padding: 2px 6px;
    border-radius: 4px;
    font: 12.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  strong {
    color: var(--fg);
    font-weight: 600;
  }
  em {
    color: var(--accent2);
    font-style: italic;
  }
  /* Brand mark — subtle bottom-right corner */
  .brand {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .brand .dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--good));
    margin-right: 6px;
    vertical-align: middle;
  }
</style>
</head>
<body>
  <div class="wrap">
    ${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ""}
    ${tableHtml}
    <div class="brand">
      <span><span class="dot"></span>cc-debrief</span>
      <span>github.com/MichaelSourbron/cc-debrief</span>
    </div>
  </div>
</body>
</html>`;
}

// -- 4. Render each table via Puppeteer -----------------------------------

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

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });

  const manifest = [];
  for (let idx = 0; idx < tables.length; idx++) {
    const t = tables[idx];
    const num = String(idx + 1).padStart(2, "0");
    const fileName = `table-${num}.png`;
    const html = pageHtml(tableMdToHtml(t.markdown), t.caption);
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // Tiny delay so fonts settle before snap.
    await new Promise((r) => setTimeout(r, 150));
    const wrap = await page.$(".wrap");
    if (!wrap) {
      console.warn(`skip ${fileName}: .wrap not found`);
      continue;
    }
    const outPath = resolve(OUT, fileName);
    await wrap.screenshot({ path: outPath });
    manifest.push({ file: fileName, caption: t.caption, line: t.lineNumber });
    console.log(`wrote ${fileName} ← ${t.caption || "(no caption)"} (line ${t.lineNumber})`);
  }

  console.log(`\nDone — ${manifest.length} table images in ${OUT}`);
  console.log("\nPaste-ready references for the article:");
  for (const m of manifest) {
    console.log(`  ![${m.caption || m.file}](images/${m.file})`);
  }
} finally {
  await browser.close();
}
