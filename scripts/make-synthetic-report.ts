// Generate a synthetic report.html with 3 sessions, 2 of them overlapping in
// time, so the multi-clauding card has data to render. Used only for capturing
// a screenshot of the parallel-sessions card without exposing real session data.
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTurns,
  analyzeToolUsage,
  analyzeRepeatedCalls,
  analyzeWallClock,
  analyzeApiErrors,
  analyzeCompactions,
  analyzeModelRouting,
  analyzeSubagents,
  analyzeSkillUsage,
  countCorrectionTurns,
  analyzeToolErrors,
  analyzeLanguages,
  analyzeTimeOfDay,
  analyzeMultiClauding,
  type IndexedSources,
} from "../core/parser.js";
import { buildReportData } from "../core/render.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeSession(sid: string, startMs: number, durationMin: number, turns: number): unknown[] {
  const records: unknown[] = [];
  const stepMs = (durationMin * 60_000) / Math.max(1, turns);
  let prev: string | null = null;
  for (let i = 0; i < turns; i++) {
    const tsUser = new Date(startMs + i * stepMs).toISOString();
    const userUuid = `u-${sid}-${i}`;
    records.push({
      type: "user",
      uuid: userUuid,
      parentUuid: prev,
      timestamp: tsUser,
      __sessionId: sid,
      message: { role: "user", content: `prompt ${i} from ${sid}` },
    });
    const tsAsst = new Date(startMs + i * stepMs + 5_000).toISOString();
    const asUuid = `a-${sid}-${i}`;
    records.push({
      type: "assistant",
      uuid: asUuid,
      parentUuid: userUuid,
      timestamp: tsAsst,
      __sessionId: sid,
      requestId: `r-${sid}-${i}`,
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 5000,
          output_tokens: 200,
        },
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      },
    });
    prev = asUuid;
  }
  return records;
}

const baseMs = new Date("2026-04-28T10:00:00Z").getTime();
// Session A: 10:00 → 12:00, 18 turns
// Session B: 11:00 → 13:00, 15 turns  (overlaps A from 11:00 → 12:00)
// Session C: 14:00 → 15:00, 10 turns  (no overlap)
const sessA = makeSession("session-a-9d4b1c2e", baseMs, 120, 18);
const sessB = makeSession("session-b-7f3e8a91", baseMs + 60 * 60_000, 120, 15);
const sessC = makeSession("session-c-2c4a6f50", baseMs + 4 * 60 * 60_000, 60, 10);

const allRecords = [...sessA, ...sessB, ...sessC];

const sources: IndexedSources = { skills: [], mcpInstructions: [] };
const turns = buildTurns(allRecords, sources);

const data = buildReportData(
  turns,
  analyzeToolUsage(allRecords),
  analyzeRepeatedCalls(allRecords),
  analyzeWallClock(turns),
  analyzeApiErrors(allRecords),
  analyzeCompactions(allRecords, turns),
  analyzeModelRouting(turns),
  analyzeSubagents(allRecords),
  sources,
  analyzeSkillUsage(allRecords),
  countCorrectionTurns(turns),
  analyzeToolErrors(allRecords),
  analyzeLanguages(allRecords),
  analyzeTimeOfDay(allRecords),
  analyzeMultiClauding(allRecords),
);

console.log("multiClauding:", data.multiClauding);

const tmpl = readFileSync(resolve(__dirname, "../cli/template.html"), "utf8");
const html = tmpl
  .replace("/*__DATA__*/null/*__END__*/", JSON.stringify(data))
  .replace("{{SOURCE_PATH}}", "Synthetic — 3 sessions, 2 overlapping (for multi-clauding screenshot)");

const out = resolve(__dirname, "../report-synthetic.html");
writeFileSync(out, html, "utf8");
console.log("wrote", out);
