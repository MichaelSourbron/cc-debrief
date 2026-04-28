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

// Target render width. Medium's body container is ~75 monospace chars wide
// at typical desktop sizes, narrower on mobile. Anything beyond this scrolls
// horizontally on the published page. Override via env var WIDTH=N.
const TARGET_WIDTH = parseInt(process.env.WIDTH ?? "75", 10);
const MIN_COL_WIDTH = 8;

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

// Greedy word-wrap of a cell's text within a max visual width. Long single
// words (e.g. URLs, long identifiers) that exceed the cap are hard-broken.
function wrapCell(text, maxWidth) {
  if (visualWidth(text) <= maxWidth) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (visualWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      // Force-break a word that's still too long on its own.
      while (visualWidth(current) > maxWidth) {
        lines.push(current.slice(0, maxWidth));
        current = current.slice(maxWidth);
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// Decide column widths: keep natural widths if they fit in TARGET_WIDTH;
// otherwise shrink the wide columns proportionally so the whole table fits.
// First column (label) is preserved when possible — it sets the row context.
function fitColumnWidths(allRows, ncols) {
  const naturals = new Array(ncols).fill(0);
  for (const row of allRows) {
    for (let i = 0; i < ncols; i++) {
      naturals[i] = Math.max(naturals[i], visualWidth(row[i]));
    }
  }
  const overhead = Math.max(0, ncols - 1) * 3; // " │ " between columns
  const available = Math.max(MIN_COL_WIDTH * ncols, TARGET_WIDTH - overhead);
  const total = naturals.reduce((a, b) => a + b, 0);
  if (total <= available) return naturals;

  // Preserve the label column up to a sane cap; shrink the data columns.
  const labelMax = Math.min(naturals[0], Math.floor(available * 0.4));
  const labelWidth = Math.max(MIN_COL_WIDTH, labelMax);
  const remaining = available - labelWidth;

  const dataNaturals = naturals.slice(1);
  const dataTotal = dataNaturals.reduce((a, b) => a + b, 0) || 1;
  const dataWidths = dataNaturals.map((n) =>
    Math.max(MIN_COL_WIDTH, Math.floor((n * remaining) / dataTotal)),
  );
  return [labelWidth, ...dataWidths];
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
  const widths = fitColumnWidths(allRows, ncols);

  // Render a single row as one or more visual lines (cells word-wrapped to
  // their column width, then zipped together vertically).
  const renderRow = (row) => {
    const cellLines = row.map((c, i) => wrapCell(c, widths[i]));
    const maxLines = Math.max(...cellLines.map((ls) => ls.length));
    const out = [];
    for (let li = 0; li < maxLines; li++) {
      const cells = cellLines.map((ls, i) => padRight(ls[li] ?? "", widths[i]));
      out.push(cells.join(" │ "));
    }
    return out;
  };

  const out = [...renderRow(headerCells)];
  out.push(widths.map((w) => "─".repeat(w)).join("─┼─"));
  for (const row of bodyCells.map(norm)) {
    out.push(...renderRow(row));
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
