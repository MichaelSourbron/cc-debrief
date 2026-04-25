#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  parseJsonl,
  buildTurns,
  findSessionCwd,
  analyzeToolUsage,
  analyzeRepeatedCalls,
  analyzeWallClock,
  analyzeApiErrors,
  analyzeCompactions,
  analyzeModelRouting,
  analyzeSubagents,
  analyzeSkillUsage,
  countCorrectionTurns,
  type IndexedSources,
  type Turn,
} from "../core/parser.js";
import { tokenCount } from "../core/tokenize.js";
import { buildReportData } from "../core/render.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function tokenizeFile(path: string): { path: string; tokens: number } | undefined {
  const text = readIfExists(path);
  if (text == null) return undefined;
  return { path, tokens: tokenCount(text) };
}

type Settings = { enabledPlugins?: Record<string, boolean> };

function readSettings(claudeDir: string): Settings {
  const text = readIfExists(join(claudeDir, "settings.json"));
  if (!text) return {};
  try {
    return JSON.parse(text) as Settings;
  } catch {
    return {};
  }
}

function findSkillFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (e === "SKILL.md") out.push(p);
    }
  }
  return out;
}

// Extract `name` and `description` from a SKILL.md's YAML front-matter.
// Tolerates the common quoting styles (none, "...", '...') on a single line.
function parseSkillFrontMatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];
  const stripQuotes = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  const name = fm.match(/^name:\s*(.+)$/m)?.[1];
  const description = fm.match(/^description:\s*(.+)$/m)?.[1];
  return {
    name: name ? stripQuotes(name) : undefined,
    description: description ? stripQuotes(description) : undefined,
  };
}

function discoverSkills(
  claudeDir: string,
  projectCwd: string | undefined,
): { name: string; path: string; tokens: number }[] {
  const settings = readSettings(claudeDir);
  const enabled = settings.enabledPlugins ?? {};
  const files = new Set<string>();

  for (const f of findSkillFiles(join(claudeDir, "skills"))) files.add(f);

  for (const [pluginKey, isEnabled] of Object.entries(enabled)) {
    if (!isEnabled) continue;
    const [pluginName, marketplace] = pluginKey.split("@");
    if (!pluginName || !marketplace) continue;
    const pluginRoot = join(claudeDir, "plugins", "cache", marketplace, pluginName);
    for (const f of findSkillFiles(pluginRoot)) files.add(f);
  }

  if (projectCwd) {
    for (const f of findSkillFiles(join(projectCwd, ".claude", "skills"))) files.add(f);
  }

  const out: { name: string; path: string; tokens: number }[] = [];
  for (const path of files) {
    const text = readIfExists(path);
    if (!text) continue;
    const fm = parseSkillFrontMatter(text);
    const name = fm.name ?? path;
    // Approximate the listing line as it appears in the system prompt.
    const listing = `- ${name}: ${fm.description ?? ""}\n`;
    out.push({ name, path, tokens: tokenCount(listing) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function indexClaudeConfig(claudeDir: string, projectCwd: string | undefined): IndexedSources {
  return {
    claudeMdUser: tokenizeFile(join(claudeDir, "CLAUDE.md")),
    claudeMdProject: projectCwd ? tokenizeFile(join(projectCwd, "CLAUDE.md")) : undefined,
    skills: discoverSkills(claudeDir, projectCwd),
    mcpInstructions: [],
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function summarize(turns: Turn[], config: IndexedSources): void {
  if (turns.length === 0) {
    console.log("no assistant turns with usage found.");
    return;
  }
  const totals = turns.reduce(
    (acc, t) => {
      acc.inputTokens += t.usage.inputTokens;
      acc.cacheCreation += t.usage.cacheCreationTokens;
      acc.cacheRead += t.usage.cacheReadTokens;
      acc.outputTokens += t.usage.outputTokens;
      acc.costUsd += t.costUsd;
      return acc;
    },
    { inputTokens: 0, cacheCreation: 0, cacheRead: 0, outputTokens: 0, costUsd: 0 },
  );
  const totalIn = totals.inputTokens + totals.cacheCreation + totals.cacheRead;
  const cacheHitRate = totalIn > 0 ? totals.cacheRead / totalIn : 0;
  console.log(`turns:           ${turns.length}`);
  console.log(`input tokens:    ${fmt(totalIn)}`);
  console.log(`output tokens:   ${fmt(totals.outputTokens)}`);
  console.log(`cache hit rate:  ${(cacheHitRate * 100).toFixed(1)}%`);
  console.log(`total cost:      $${totals.costUsd.toFixed(4)}`);
  console.log("");
  console.log("indexed sources:");
  console.log(
    `  CLAUDE.md (user):    ${config.claudeMdUser ? fmt(config.claudeMdUser.tokens) + " tok" : "—"}`,
  );
  console.log(
    `  CLAUDE.md (project): ${config.claudeMdProject ? fmt(config.claudeMdProject.tokens) + " tok  " + config.claudeMdProject.path : "—"}`,
  );
  const skillTotal = config.skills.reduce((a, s) => a + s.tokens, 0);
  console.log(`  skills:              ${config.skills.length} skills, ${fmt(skillTotal)} tok (listing)`);
}

function renderHtml(jsonlPath: string, data: unknown): string {
  const tmpl = readFileSync(resolve(__dirname, "template.html"), "utf8");
  const json = JSON.stringify(data);
  return tmpl
    .replace("/*__DATA__*/null/*__END__*/", json)
    .replace("{{SOURCE_PATH}}", escapeHtml(jsonlPath));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function main(): void {
  const jsonlPath = process.argv[2];
  if (!jsonlPath) {
    console.error("usage: cc-debrief <session.jsonl> [--out <path>]");
    process.exit(1);
  }
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx > 0 ? process.argv[outIdx + 1] : resolve(process.cwd(), "report.html");

  const claudeDir = resolve(homedir(), ".claude");
  const text = readFileSync(jsonlPath, "utf8");
  const records = parseJsonl(text);
  const sessionCwd = findSessionCwd(records);
  const sources = indexClaudeConfig(claudeDir, sessionCwd);
  const turns = buildTurns(records, sources);
  const toolStats = analyzeToolUsage(records);
  const repeated = analyzeRepeatedCalls(records);
  const wallClock = analyzeWallClock(turns);
  const apiErrors = analyzeApiErrors(records);
  const compactions = analyzeCompactions(records, turns);
  const routing = analyzeModelRouting(turns);
  const subagents = analyzeSubagents(records);
  const invokedSkills = analyzeSkillUsage(records);
  const corrections = countCorrectionTurns(turns);

  console.log(`file: ${jsonlPath}`);
  console.log(`records parsed:  ${fmt(records.length)}`);
  console.log(`session cwd:     ${sessionCwd ?? "—"}`);
  summarize(turns, sources);
  if (toolStats.length > 0) {
    console.log("");
    console.log("top tools by token volume:");
    for (const s of toolStats.slice(0, 8)) {
      console.log(
        `  ${s.name.padEnd(20)} ${fmt(s.resultTokens).padStart(10)} tok  ${s.calls.toString().padStart(4)} calls  (mean ${fmt(s.meanResultTokens)})`,
      );
    }
  }
  if (repeated.byFile.length > 0 || repeated.byCommand.length > 0) {
    console.log("");
    console.log(`repeated calls (~${fmt(repeated.totalWastedTokens)} tok wasted on calls 2..N):`);
    for (const s of repeated.byFile.slice(0, 5)) {
      const target = s.target.length > 60 ? "…" + s.target.slice(-59) : s.target;
      console.log(`  ${s.calls.toString().padStart(4)}×  ${fmt(s.totalTokens).padStart(8)} tok  ${target}`);
    }
    for (const s of repeated.byCommand.slice(0, 5)) {
      console.log(`  ${s.calls.toString().padStart(4)}×  ${fmt(s.totalTokens).padStart(8)} tok  Bash: ${s.target}`);
    }
  }

  const html = renderHtml(
    jsonlPath,
    buildReportData(
      turns,
      toolStats,
      repeated,
      wallClock,
      apiErrors,
      compactions,
      routing,
      subagents,
      sources,
      invokedSkills,
      corrections,
    ),
  );
  writeFileSync(outPath, html, "utf8");
  console.log("");
  console.log(`report written:  ${outPath}`);
}

main();
