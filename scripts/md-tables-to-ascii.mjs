// Convert every markdown table in an article into a Unicode-aligned ASCII
// table inside a fenced code block. Output goes to a sibling .ascii.md file
// (non-destructive). Code blocks survive copy-paste into Medium intact, so
// the published article ends up with table-shaped content that doesn't
// require image uploads.
//
// Usage:
//   node scripts/md-tables-to-ascii.mjs [source.md]
// Default source: articles/03-used-insights-as-spec.md

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";

const SOURCE = resolve(process.argv[2] ?? "articles/03-used-insights-as-spec.md");
const dir = dirname(SOURCE);
const base = basename(SOURCE).replace(/\.md$/, "");
const OUT = resolve(dir, `${base}.ascii.md`);

// -- Visual width helpers ------------------------------------------------
// Most fonts render emoji as 2 monospace columns. Approximate by treating
// codepoints in common emoji ranges as width 2, everything else as 1.

function visualWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji block
      (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols incl ✅ ⚠️ ❌ ✓
      (cp >= 0x1f900 && cp <= 0x1f9ff) // supplemental symbols
    ) {
      w += 2;
    } else if (cp === 0xfe0f) {
      // Variation selector — does not add visual width.
    } else {
      w += 1;
    }
  }
  return w;
}

function padRight(s, width) {
  const need = width - visualWidth(s);
  return s + " ".repeat(Math.max(0, need));
}

// -- Strip simple markdown so the display width is honest ----------------
function stripInline(cell) {
  return cell
    .replace(/`([^`]+)`/g, "$1")                  // `code` → code
    .replace(/\*\*([^*]+)\*\*/g, "$1")             // **bold** → bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")   // *italic* → italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");     // [text](url) → text
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

// -- Render a single table block as a fenced ASCII code block ------------
function renderTable(rows) {
  const headerCells = splitRow(rows[0]).map(stripInline);
  const bodyCells = rows.slice(2).map((r) => splitRow(r).map(stripInline));
  const ncols = headerCells.length;

  // Pad short rows out to ncols so column math doesn't blow up.
  const norm = (row) => {
    const out = row.slice(0, ncols);
    while (out.length < ncols) out.push("");
    return out;
  };
  const allRows = [headerCells, ...bodyCells.map(norm)];

  // Compute column widths from visual width of every cell.
  const widths = new Array(ncols).fill(0);
  for (const row of allRows) {
    for (let i = 0; i < ncols; i++) {
      const w = visualWidth(row[i]);
      if (w > widths[i]) widths[i] = w;
    }
  }

  // Row format: "cell1 │ cell2 │ cell3"
  // Sep format: "─────┼─────┼─────" (─ matching widths[i], ┼ at column boundaries)
  const fmtRow = (row) => row.map((c, i) => padRight(c, widths[i])).join(" │ ");
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");

  const out = [fmtRow(headerCells), sep];
  for (const row of bodyCells.map(norm)) {
    out.push(fmtRow(row));
  }

  return "```\n" + out.join("\n") + "\n```";
}

// -- Walk the source markdown and replace tables in place ----------------
const text = readFileSync(SOURCE, "utf8");
const lines = text.split(/\r?\n/);

const result = [];
let i = 0;
let tableCount = 0;
while (i < lines.length) {
  const line = lines[i];
  const next = lines[i + 1] ?? "";
  const isHeader = line.trim().startsWith("|") && line.trim().endsWith("|");
  const isSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(next);
  if (isHeader && isSeparator) {
    const block = [line, next];
    i += 2;
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      block.push(lines[i]);
      i += 1;
    }
    result.push(renderTable(block));
    tableCount += 1;
    continue;
  }
  result.push(line);
  i += 1;
}

const banner =
  `<!-- Auto-generated from ${basename(SOURCE)} on ${new Date().toISOString()}. ` +
  `Markdown tables converted to monospace ASCII tables in fenced code blocks ` +
  `so they survive copy-paste into Medium. Run scripts/md-tables-to-ascii.mjs to regenerate. -->\n\n`;

writeFileSync(OUT, banner + result.join("\n"), "utf8");
console.log(`wrote ${OUT} — converted ${tableCount} tables`);
