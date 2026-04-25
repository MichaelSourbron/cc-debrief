import type {
  Turn,
  TurnUsage,
  Source,
  SourceKind,
  ToolStat,
  RepeatedCallStat,
  RepeatedCallStats,
  WallClock,
  ApiErrorStats,
  CompactionEvent,
  ModelRouting,
  ModelRecommendation,
  SubagentStats,
  IndexedSources,
} from "./parser.js";

export type EChartsOption = Record<string, unknown>;

const KIND_COLORS: Record<SourceKind, string> = {
  "static-system": "#6e7681",
  "claude-md-user": "#bc8cff",
  "claude-md-project": "#a371f7",
  "skill-listing": "#79c0ff",
  history: "#3fb950",
  "this-turn-user": "#f85149",
  "this-turn-tool-result": "#d29922",
};

const KIND_ORDER: SourceKind[] = [
  "static-system",
  "claude-md-user",
  "claude-md-project",
  "skill-listing",
  "history",
  "this-turn-tool-result",
  "this-turn-user",
];

const KIND_LABELS: Record<SourceKind, string> = {
  "static-system": "System prompt + tool schemas",
  "claude-md-user": "CLAUDE.md (user)",
  "claude-md-project": "CLAUDE.md (project)",
  "skill-listing": "Skill listing (name + description)",
  history: "Conversation history",
  "this-turn-user": "This turn — user msg",
  "this-turn-tool-result": "This turn — tool results",
};

export type TopStrip = {
  turns: number;
  totalInputTokens: number;
  inputNew: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
  outputTokens: number;
  costUsd: number;
  cacheHitRate: number;
  models: string[];
  modelSwitches: number;
  wallClockMs: number;
  longGapsCount: number;
  maxGapMs: number;
};

export type ReportData = {
  hero: HeroData;
  topStrip: TopStrip;
  insights: Insight[];
  recommendations: Recommendation[];
  tokensPerTurn: EChartsOption;
  costAndCache: EChartsOption;
  treemap: EChartsOption;
  stackedArea: EChartsOption;
  toolUsage: EChartsOption;
  toolUsageRows: ToolStat[];
  repeatedFiles: EChartsOption;
  repeatedCommands: EChartsOption;
  repeatedCalls: RepeatedCallStats;
  idleGaps: EChartsOption;
  wallClock: WallClock;
  modelRouting: ModelRouting;
  topTurns: TopTurnRow[];
  bucketed: boolean;
  bucketSize: number;
  focusTurnInfo: { index: number; costUsd: number; total: number };
  modelTimeline: { index: number; model: string; timestamp: string }[];
};

export type Insight = {
  level: "info" | "warn" | "good";
  text: string;
  action?: string;
};

export type HeroData = {
  primaryValue: string;
  primaryLabel: string;
  secondaryValue: string;
  secondaryLabel: string;
  tagline: string;
};

export type Recommendation = {
  title: string;          // imperative, e.g. "Pin hot files in CLAUDE.md"
  pattern: string;        // why we're suggesting this — what we saw in the data
  why: string;            // one sentence on the mechanism
  snippet?: string;       // optional copy-paste artifact (config / command)
  snippetLang?: string;   // hint for syntax highlighting (md, json, sh, ts)
  estimatedImpact: string; // "$X saved per session" / "Y% lower tokens" / "qualitative"
};

export type TopTurnRow = {
  index: number;
  costUsd: number;
  totalInput: number;
  outputTokens: number;
  cacheHitRate: number;
  model: string;
  timestamp: string;
  subject: string;
  assistantPreview: string;
  toolsCalled: string[];
};

export function topStripData(turns: Turn[], wc?: WallClock): TopStrip {
  const totals = turns.reduce(
    (a, t) => {
      a.inputNew += t.usage.inputTokens;
      a.cacheCreation += t.usage.cacheCreationTokens;
      a.cacheCreation5m += t.usage.cacheCreation5mTokens;
      a.cacheCreation1h += t.usage.cacheCreation1hTokens;
      a.cacheRead += t.usage.cacheReadTokens;
      a.outputTokens += t.usage.outputTokens;
      a.costUsd += t.costUsd;
      return a;
    },
    {
      inputNew: 0,
      cacheCreation: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      cacheRead: 0,
      outputTokens: 0,
      costUsd: 0,
    },
  );
  const totalIn = totals.inputNew + totals.cacheCreation + totals.cacheRead;
  let modelSwitches = 0;
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].model !== turns[i - 1].model) modelSwitches++;
  }
  return {
    turns: turns.length,
    totalInputTokens: totalIn,
    inputNew: totals.inputNew,
    cacheCreation: totals.cacheCreation,
    cacheCreation5m: totals.cacheCreation5m,
    cacheCreation1h: totals.cacheCreation1h,
    cacheRead: totals.cacheRead,
    outputTokens: totals.outputTokens,
    costUsd: totals.costUsd,
    cacheHitRate: totalIn > 0 ? totals.cacheRead / totalIn : 0,
    models: [...new Set(turns.map((t) => t.model))],
    modelSwitches,
    wallClockMs: wc?.totalSpanMs ?? 0,
    longGapsCount: wc?.longGapsCount ?? 0,
    maxGapMs: wc?.maxGapMs ?? 0,
  };
}

// Bucket turns when there are too many to render individually.
// Returns 1 bucket per turn if turns.length <= maxBuckets; otherwise groups
// adjacent turns. Each bucket carries the contained turns and a label.
const MAX_X_POINTS = 200;

function bucketize(turns: Turn[]): { label: string; turns: Turn[] }[] {
  if (turns.length <= MAX_X_POINTS) {
    return turns.map((t) => ({ label: String(t.index), turns: [t] }));
  }
  const size = Math.ceil(turns.length / MAX_X_POINTS);
  const out: { label: string; turns: Turn[] }[] = [];
  for (let i = 0; i < turns.length; i += size) {
    const sub = turns.slice(i, i + size);
    const a = sub[0].index;
    const b = sub[sub.length - 1].index;
    out.push({ label: a === b ? String(a) : `${a}-${b}`, turns: sub });
  }
  return out;
}

function bucketSizeFor(turns: Turn[]): number {
  return turns.length > MAX_X_POINTS ? Math.ceil(turns.length / MAX_X_POINTS) : 1;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

export function tokensPerTurnChart(turns: Turn[]): EChartsOption {
  const buckets = bucketize(turns);
  const bucketed = buckets.length < turns.length;
  const xs = buckets.map((b) => b.label);
  const sumKey = (key: keyof TurnUsage) =>
    buckets.map((b) => sum(b.turns.map((t) => t.usage[key])));
  const titleSuffix = bucketed ? `  ·  ${buckets[0].turns.length} turns/bucket` : "";
  return {
    title: {
      text: "Tokens per turn" + titleSuffix,
      left: "center",
      textStyle: { color: "#e6edf3" },
    },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      data: ["Cache read", "Cache creation", "New input", "Output"],
      top: 28,
      textStyle: { color: "#e6edf3" },
    },
    grid: { left: 60, right: 30, top: 70, bottom: 50 },
    xAxis: { type: "category", data: xs, name: "turn", axisLabel: { color: "#8b949e" } },
    yAxis: { type: "value", name: "tokens", axisLabel: { color: "#8b949e" } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 20, bottom: 10 }],
    series: [
      {
        name: "Cache read",
        type: "bar",
        stack: "input",
        itemStyle: { color: "#3fb950" },
        data: sumKey("cacheReadTokens"),
      },
      {
        name: "Cache creation",
        type: "bar",
        stack: "input",
        itemStyle: { color: "#d29922" },
        data: sumKey("cacheCreationTokens"),
      },
      {
        name: "New input",
        type: "bar",
        stack: "input",
        itemStyle: { color: "#f85149" },
        data: sumKey("inputTokens"),
      },
      {
        name: "Output",
        type: "bar",
        itemStyle: { color: "#58a6ff" },
        data: sumKey("outputTokens"),
      },
    ],
  };
}

export function costAndCacheChart(turns: Turn[]): EChartsOption {
  const buckets = bucketize(turns);
  const bucketed = buckets.length < turns.length;
  const titleSuffix = bucketed ? `  ·  ${buckets[0].turns.length} turns/bucket (cost summed, cache hit averaged)` : "";
  const costs = buckets.map((b) => +sum(b.turns.map((t) => t.costUsd)).toFixed(4));
  const cacheHit = buckets.map((b) => {
    const totIn = sum(
      b.turns.flatMap((t) => [t.usage.inputTokens, t.usage.cacheCreationTokens, t.usage.cacheReadTokens]),
    );
    const totRead = sum(b.turns.map((t) => t.usage.cacheReadTokens));
    return totIn > 0 ? +((100 * totRead) / totIn).toFixed(1) : 0;
  });
  return {
    title: { text: "Cost vs cache hit rate" + titleSuffix, left: "center", textStyle: { color: "#e6edf3" } },
    tooltip: { trigger: "axis" },
    legend: {
      data: ["Cost (USD)", "Cache hit %"],
      top: 28,
      textStyle: { color: "#e6edf3" },
    },
    grid: { left: 60, right: 60, top: 70, bottom: 50 },
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      name: "turn",
      axisLabel: { color: "#8b949e" },
    },
    yAxis: [
      { type: "value", name: "cost ($)", position: "left", axisLabel: { color: "#8b949e" } },
      {
        type: "value",
        name: "cache hit %",
        position: "right",
        min: 0,
        max: 100,
        axisLabel: { color: "#8b949e" },
      },
    ],
    dataZoom: [{ type: "inside" }, { type: "slider", height: 20, bottom: 10 }],
    series: [
      {
        name: "Cost (USD)",
        type: "bar",
        yAxisIndex: 0,
        itemStyle: { color: "#bc8cff" },
        data: costs,
      },
      {
        name: "Cache hit %",
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#3fb950", width: 2 },
        data: cacheHit,
      },
    ],
  };
}

function pickFocusTurn(turns: Turn[]): Turn {
  return turns.reduce((best, t) => (t.costUsd > best.costUsd ? t : best), turns[0]);
}

function generateRecommendations(
  turns: Turn[],
  toolStats: ToolStat[],
  repeated: RepeatedCallStats,
  wc: WallClock,
  routing: ModelRouting,
  config: IndexedSources,
  invokedSkills: Set<string>,
  corrections: { count: number; examples: { index: number; subject: string }[] },
): Recommendation[] {
  const recs: Recommendation[] = [];
  const main = turns.reduce((s, t) => s + t.costUsd, 0);

  // 1. Pin hot files. Threshold: any file read >10 times.
  const hotFiles = repeated.byFile.filter((f) => f.calls >= 10).slice(0, 5);
  if (hotFiles.length > 0) {
    const wasted = hotFiles.reduce(
      (a, f) => a + Math.round((f.totalTokens * (f.calls - 1)) / f.calls),
      0,
    );
    const lines = hotFiles
      .map((f) => `- [${f.target.split(/[\\/]/).pop()}](${f.target.replace(/\\/g, "/")})`)
      .join("\n");
    recs.push({
      title: "Pin your hot files in CLAUDE.md",
      pattern: `${hotFiles.length} file${hotFiles.length === 1 ? "" : "s"} were read 10+ times — top: ${hotFiles[0].target.split(/[\\/]/).pop()} (${hotFiles[0].calls}×).`,
      why: "Files referenced from CLAUDE.md cache once at session start instead of being re-read every time.",
      snippet: `## Hot files\n\n${lines}\n`,
      snippetLang: "md",
      estimatedImpact: `~${wasted.toLocaleString("en-US")} tokens saved per session of similar shape.`,
    });
  }

  // 2. Try Sonnet by default if it'd save >20%.
  const sonnetSave = main - routing.ifAllSonnet;
  if (sonnetSave > 50 && main > 100 && sonnetSave > main * 0.2) {
    recs.push({
      title: "Default to Sonnet at session start",
      pattern: `${turns[0]?.model.includes("opus") ? "Opus" : turns[0]?.model} ran the session, but ~$${sonnetSave.toFixed(0)} (${((sonnetSave / main) * 100).toFixed(0)}%) of cost would have been avoided on Sonnet.`,
      why: "Model choice at session start preserves the prompt cache. Switching mid-session re-uploads ~50K tokens.",
      snippet: `# At the prompt:\n/model sonnet\n\n# Or in <project>/.claude/settings.json:\n{ "model": "claude-sonnet-4-6" }`,
      snippetLang: "sh",
      estimatedImpact: `~$${sonnetSave.toFixed(2)} per session of similar size.`,
    });
  }

  // 3. PostToolUse hook to trim large Read outputs.
  const readStat = toolStats.find((t) => t.name === "Read");
  if (readStat && readStat.meanResultTokens > 3000 && readStat.calls >= 10) {
    recs.push({
      title: "Trim large Read outputs with a hook",
      pattern: `Read averaged ${readStat.meanResultTokens.toLocaleString("en-US")} tokens/call across ${readStat.calls} calls. Large reads accumulate in conversation history forever.`,
      why: "A PostToolUse hook can replace oversized output with a head/tail summary before it enters context.",
      snippet: `// ~/.claude/settings.json\n{\n  "hooks": {\n    "PostToolUse": [{\n      "matcher": "Read",\n      "hooks": [{\n        "type": "command",\n        "command": "node trim-large-read.js"\n      }]\n    }]\n  }\n}`,
      snippetLang: "json",
      estimatedImpact: `Cuts ~50% of Read result tokens on calls over 5KB.`,
    });
  }

  // 4. /clear after long idle gaps instead of resuming.
  if (wc.longGapsCount >= 3 && wc.maxGapMs > 60 * 60 * 1000) {
    recs.push({
      title: "Use /clear after long breaks instead of resuming",
      pattern: `${wc.longGapsCount} gaps over 5 min, max ${formatDuration(wc.maxGapMs)}. The cache expires after 5 min — resuming pays full re-warm.`,
      why: "A fresh /clear session pays the same one-time cache write but avoids dragging accumulated history. Pinned files re-cache cheaply.",
      snippet: `# Before walking away for >1h:\n/clear\n# Then on resume, the next turn writes to a fresh cache.`,
      snippetLang: "sh",
      estimatedImpact: `Avoids re-warming ${wc.longGapsCount} times — concretely depends on context size at each gap.`,
    });
  }

  // 5. Manual /compact at topic boundaries.
  if (turns.length >= 200) {
    recs.push({
      title: "Compact at semantic topic shifts, not at 80% threshold",
      pattern: `${turns.length}-turn session. Auto-compact only fires at 80% context — by then the conversation already paid for the bloat on every prior turn.`,
      why: "Earlier manual /compact removes drag while context is still focused, before tool outputs and stale tangents accumulate.",
      snippet: `# When you switch from auth work to CSS work, before the new prompt:\n/compact`,
      snippetLang: "sh",
      estimatedImpact: `Cuts cumulative input by 30-60% across the next N turns of a new topic.`,
    });
  }

  // 6. Reduce repeated cd / setup commands via absolute paths.
  const cdCmd = repeated.byCommand.find((c) => c.target === "cd");
  if (cdCmd && cdCmd.calls >= 30) {
    recs.push({
      title: "Use absolute paths in Bash, not cd",
      pattern: `cd was run ${cdCmd.calls}× returning ${cdCmd.totalTokens.toLocaleString("en-US")} tokens of output. Each cd is a tool result block in conversation history.`,
      why: "Absolute-path commands return less and don't change session state, so they don't need a paired cd.",
      snippet: `# instead of:\ncd src/foo && cat bar.ts\n\n# use:\ncat src/foo/bar.ts`,
      snippetLang: "sh",
      estimatedImpact: `~${cdCmd.totalTokens.toLocaleString("en-US")} tokens of cd output on a session like this one.`,
    });
  }

  // 7. Unused enabled skills/plugins.
  // Match invoked skill strings loosely against enabled skill names.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const invokedNorm = new Set([...invokedSkills].map(norm));
  const wasInvoked = (skillName: string) => {
    const n = norm(skillName);
    if (invokedNorm.has(n)) return true;
    for (const inv of invokedNorm) {
      if (inv.includes(n) || n.includes(inv)) return true;
    }
    return false;
  };
  const unused = config.skills.filter((s) => !wasInvoked(s.name));
  if (unused.length >= 3 && config.skills.length >= 5) {
    const wastedTokens = unused.reduce((a, s) => a + s.tokens, 0);
    const examples = unused.slice(0, 8).map((s) => `- ${s.name}`).join("\n");
    recs.push({
      title: "Disable unused skills/plugins",
      pattern: `${config.skills.length} skills enabled but only ${invokedSkills.size} were invoked. ${unused.length} were never used this session.`,
      why: "Every enabled skill contributes its name+description to the system prompt every turn. Unused skills are pure overhead.",
      snippet:
        `# Skills never invoked this session — consider disabling:\n${examples}\n\n# Disable a plugin via:\n# Edit ~/.claude/settings.json → "enabledPlugins" map`,
      snippetLang: "sh",
      estimatedImpact: `~${wastedTokens.toLocaleString("en-US")} tokens of skill listing per turn (small but cumulative across long sessions).`,
    });
  }

  // 8. Correction loops — high count of "no / wrong / still doesn't work" prompts.
  const corrPct =
    turns.length > 0 ? (corrections.count / turns.length) * 100 : 0;
  if (corrections.count >= 5 || corrPct >= 5) {
    const exList = corrections.examples
      .slice(0, 3)
      .map((e) => `# turn #${e.index}: "${e.subject.slice(0, 70)}"`)
      .join("\n");
    recs.push({
      title: "Break out of correction loops",
      pattern: `${corrections.count} turn${corrections.count === 1 ? "" : "s"} (${corrPct.toFixed(1)}%) looked like corrections — "no", "still doesn't work", "fix it", "again". Consecutive corrections often mean Claude is stuck on a wrong approach.`,
      why: 'After ~2 failed corrections, the conversation has accumulated failed attempts that pollute context. /clear and re-prompt with what you learned beats trying to redirect mid-session.',
      snippet: `# When you notice you're correcting twice in a row:\n/clear\n\n# Then start a fresh prompt incorporating what didn't work:\n# "Implement X. Note: Y approach didn't work because Z."\n\n${exList}`,
      snippetLang: "sh",
      estimatedImpact: `Hard to quantify — but escapes a class of session-killer pattern.`,
    });
  }

  // 9. Over-specified CLAUDE.md.
  const userMd = config.claudeMdUser?.tokens ?? 0;
  const projMd = config.claudeMdProject?.tokens ?? 0;
  const oversized: string[] = [];
  if (userMd > 5000) oversized.push(`user CLAUDE.md is ${userMd.toLocaleString("en-US")} tokens (~${Math.round(userMd / 1000)}KB)`);
  if (projMd > 5000) oversized.push(`project CLAUDE.md is ${projMd.toLocaleString("en-US")} tokens (~${Math.round(projMd / 1000)}KB)`);
  if (oversized.length > 0) {
    recs.push({
      title: "Trim your CLAUDE.md",
      pattern: oversized.join("; "),
      why: "Over-specified CLAUDE.md gets ignored — Claude treats long instruction lists as noise. Community consensus is keep it under ~5K tokens with crisp imperative rules.",
      snippet: `# Pruning checklist:\n# - Delete instructions Claude already follows by default\n# - Move automation rules into hooks (settings.json), not prose\n# - Replace "always do X" with one bullet per non-obvious rule\n# - If a rule is project-specific, move it to <project>/.claude/CLAUDE.md, not the user-level one`,
      snippetLang: "sh",
      estimatedImpact: `Reduces every-turn overhead AND improves rule compliance.`,
    });
  }

  // 10. Plan-mode usage.
  const planStat = toolStats.find((t) => t.name === "ExitPlanMode");
  if (turns.length >= 100 && (!planStat || planStat.calls === 0)) {
    recs.push({
      title: "Try Plan Mode for complex work",
      pattern: `${turns.length}-turn session with no Plan Mode activations. Plan Mode separates exploration from execution — the cheaper thinking pass saves the expensive execution pass.`,
      why: "With Opus-in-plan + Sonnet-for-execution, you get high-quality reasoning where it matters without paying Opus rates per code line.",
      snippet: `# Enter plan mode at the start of a complex task:\n# Press Shift+Tab twice (or use /opusplan)\n\n# Claude lays out an approach, you approve, it executes.`,
      snippetLang: "sh",
      estimatedImpact: `~30-60% cost reduction on multi-step tasks where the plan is clear before code.`,
    });
  }

  // 11. Oversized user prompts (pasted specs, error traces, multiple files in one message).
  const largePrompts = turns
    .map((t) => ({
      turn: t,
      tokens: t.sources.find((s) => s.kind === "this-turn-user")?.tokens ?? 0,
    }))
    .filter((x) => x.tokens >= 2000)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
  if (largePrompts.length > 0) {
    const top = largePrompts[0];
    const list = largePrompts
      .map(
        (x) =>
          `# turn #${x.turn.index} — ~${x.tokens.toLocaleString("en-US")} tok: "${x.turn.userPromptPreview.slice(0, 60)}..."`,
      )
      .join("\n");
    const totalTokens = largePrompts.reduce((s, x) => s + x.tokens, 0);
    recs.push({
      title: "Trim oversized user prompts",
      pattern: `${largePrompts.length} prompt${largePrompts.length === 1 ? "" : "s"} exceeded 2,000 tokens. Largest: ~${top.tokens.toLocaleString("en-US")} tokens (turn #${top.turn.index}).`,
      why: "Pasted specs, full error traces, and multiple files in one message inflate the prompt and reduce cache locality. Smaller prompts let cache work better and keep replies focused.",
      snippet: `# Instead of pasting everything in one message:\n# - Trim error traces to the relevant frames\n# - Reference files by path; let Claude Read on demand\n# - Split spec + question into separate turns\n\n${list}`,
      snippetLang: "sh",
      estimatedImpact: `~${totalTokens.toLocaleString("en-US")} tokens of one-off prompt input on this session.`,
    });
  }

  // Rank by impact rough heuristic — items with $-numbers in estimatedImpact float up.
  const score = (r: Recommendation) => {
    const m = r.estimatedImpact.match(/\$([0-9,.]+)/);
    if (m) return parseFloat(m[1].replace(/,/g, "")) * 1000;
    const t = r.estimatedImpact.match(/([0-9,]+) tokens/);
    if (t) return parseFloat(t[1].replace(/,/g, ""));
    return 1;
  };
  return recs.sort((a, b) => score(b) - score(a)).slice(0, 5);
}

function heroData(
  turns: Turn[],
  wc: WallClock,
  routing: ModelRouting,
  subagents: SubagentStats,
  repeated: RepeatedCallStats,
): HeroData {
  const main = turns.reduce((s, t) => s + t.costUsd, 0);
  const grand = main + subagents.totalCostUsd;
  const sonnetSave = main - routing.ifAllSonnet;

  let secondaryValue = `${turns.length.toLocaleString("en-US")}`;
  let secondaryLabel = "turns";
  if (sonnetSave > 50 && main > 100) {
    secondaryValue = `~$${sonnetSave.toFixed(0)}`;
    secondaryLabel = `saveable on Sonnet (${((sonnetSave / main) * 100).toFixed(0)}%)`;
  } else if (repeated.totalWastedTokens > 100_000) {
    secondaryValue = `${Math.round(repeated.totalWastedTokens / 1000).toLocaleString("en-US")}K`;
    secondaryLabel = "tokens wasted on repeated reads";
  } else if (wc.longGapsCount > 5) {
    secondaryValue = `${wc.longGapsCount}`;
    secondaryLabel = `idle gaps over 5 min`;
  }

  const totalIn = turns.reduce(
    (s, t) => s + t.usage.inputTokens + t.usage.cacheCreationTokens + t.usage.cacheReadTokens,
    0,
  );
  const cacheRead = turns.reduce((s, t) => s + t.usage.cacheReadTokens, 0);
  const cachePct = totalIn > 0 ? (cacheRead / totalIn) * 100 : 0;
  const taglineParts: string[] = [];
  if (wc.totalSpanMs > 0) taglineParts.push(formatDuration(wc.totalSpanMs));
  taglineParts.push(`${turns.length.toLocaleString("en-US")} turns`);
  taglineParts.push(`${cachePct.toFixed(1)}% cache hits`);
  if (subagents.totalAgents > 0) taglineParts.push(`${subagents.totalAgents} subagents`);

  return {
    primaryValue: `$${grand.toFixed(grand >= 100 ? 0 : 2)}`,
    primaryLabel: subagents.totalAgents > 0 ? "Total cost (incl. subagents)" : "Total cost",
    secondaryValue,
    secondaryLabel,
    tagline: taglineParts.join("  ·  "),
  };
}

function generateInsights(
  turns: Turn[],
  toolStats: ToolStat[],
  repeated: RepeatedCallStats,
  wc: WallClock,
  apiErrors: ApiErrorStats,
  compactions: CompactionEvent[],
  routing: ModelRouting,
  subagents: SubagentStats,
): Insight[] {
  const out: Insight[] = [];
  if (turns.length === 0) return out;

  const totalCost = turns.reduce((a, t) => a + t.costUsd, 0);
  const sortedByCost = [...turns].sort((a, b) => b.costUsd - a.costUsd);
  const peak = sortedByCost[0];
  const peakShare = totalCost > 0 ? (peak.costUsd / totalCost) * 100 : 0;
  out.push({
    level: "info",
    text: `Most expensive turn: #${peak.index} at $${peak.costUsd.toFixed(4)} (${peakShare.toFixed(1)}% of session cost). Open the table below to see the rest of the top 10.`,
  });

  const top10 = sortedByCost.slice(0, 10).reduce((a, t) => a + t.costUsd, 0);
  const top10Share = totalCost > 0 ? (top10 / totalCost) * 100 : 0;
  if (turns.length >= 50) {
    out.push({
      level: "info",
      text: `Top 10 turns drive ${top10Share.toFixed(1)}% of total cost. ${
        top10Share > 25
          ? "Cost is concentrated — find what made those turns expensive."
          : "Cost is well-distributed — no single hot turn to fix."
      }`,
    });
  }

  const totals = turns.reduce(
    (a, t) => {
      a.in += t.usage.inputTokens + t.usage.cacheCreationTokens + t.usage.cacheReadTokens;
      a.read += t.usage.cacheReadTokens;
      return a;
    },
    { in: 0, read: 0 },
  );
  const cacheHit = totals.in > 0 ? (totals.read / totals.in) * 100 : 0;
  if (cacheHit >= 90) {
    out.push({ level: "good", text: `Cache hit rate ${cacheHit.toFixed(1)}% — excellent, the prompt cache is doing its job.` });
  } else if (cacheHit >= 75) {
    out.push({ level: "info", text: `Cache hit rate ${cacheHit.toFixed(1)}% — fine but could be higher; check for mid-session model/setting changes.` });
  } else {
    out.push({ level: "warn", text: `Cache hit rate ${cacheHit.toFixed(1)}% — low. Likely cause: model switches, settings changes, or many short fresh sessions instead of one long one.` });
  }

  const models = new Set(turns.map((t) => t.model));
  let switches = 0;
  for (let i = 1; i < turns.length; i++) if (turns[i].model !== turns[i - 1].model) switches++;
  if (switches > 0) {
    out.push({
      level: "warn",
      text: `${switches} model switch${switches === 1 ? "" : "es"} detected (${[...models].join(", ")}). Each switch breaks the cache and re-uploads the system prompt.`,
    });
  }

  if (toolStats.length > 0) {
    const top = toolStats[0];
    out.push({
      level: "info",
      text: `Top tool by volume: ${top.name} returned ${top.resultTokens.toLocaleString("en-US")} tokens across ${top.calls} calls (mean ${top.meanResultTokens.toLocaleString("en-US")}/call, max ${top.maxResultTokens.toLocaleString("en-US")}).`,
    });
    if (top.meanResultTokens > 3000 && top.calls >= 5) {
      out.push({
        level: "warn",
        text: `${top.name} averages ${top.meanResultTokens.toLocaleString("en-US")} tokens per call — large outputs accumulate in conversation history forever.`,
        action: `Add a PostToolUse hook in ~/.claude/settings.json that trims ${top.name} results over ~5KB before they enter context.`,
      });
    }
  }

  if (turns.length >= 200) {
    out.push({
      level: "info",
      text: `Long session (${turns.length} turns). Even with high cache hit, total cumulative input scales linearly with turn count.`,
      action: `Manual /compact at semantic topic shifts is more efficient than waiting for the 80% threshold.`,
    });
  }

  if (repeated.byFile.length > 0) {
    const top = repeated.byFile[0];
    out.push({
      level: "warn",
      text: `Repeated reads: "${top.target.slice(-50)}" was touched ${top.calls}× for ${top.totalTokens.toLocaleString("en-US")} total tokens. ~${Math.round((top.totalTokens * (top.calls - 1)) / top.calls).toLocaleString("en-US")} of those were avoidable redundant input.`,
      action: `Pin "${top.target.split(/[\\/]/).pop()}" in your project CLAUDE.md, or use a dedupe-aware MCP server (e.g. lean-ctx).`,
    });
  }
  if (repeated.totalWastedTokens > 5000) {
    out.push({
      level: "warn",
      text: `~${repeated.totalWastedTokens.toLocaleString("en-US")} tokens spent re-reading already-seen content (files + Bash commands beyond their first invocation).`,
      action: `See "Token waste" card below for the full ranked list — pin top files in CLAUDE.md or install lean-ctx.`,
    });
  }
  if (wc.totalSpanMs > 0) {
    if (wc.longGapsCount > 0) {
      out.push({
        level: "warn",
        text: `${wc.longGapsCount} idle gap${wc.longGapsCount === 1 ? "" : "s"} exceeded 5 minutes (max ${formatDuration(wc.maxGapMs)}). Each one likely expired the prompt cache — the next turn paid full input rate to re-warm.`,
        action: `For long breaks, prefer /clear and a fresh session over resuming. Pin hot files in CLAUDE.md so they re-cache cheaply on a new session.`,
      });
    } else {
      out.push({
        level: "good",
        text: `Session was active throughout — no idle gaps over 5 minutes, so the prompt cache stayed warm.`,
      });
    }
  }

  // Cache TTL split: only meaningful if we saw any cache writes at all.
  const totalCw = turns.reduce(
    (a, t) => a + t.usage.cacheCreation5mTokens + t.usage.cacheCreation1hTokens,
    0,
  );
  if (totalCw > 0) {
    const cw1h = turns.reduce((a, t) => a + t.usage.cacheCreation1hTokens, 0);
    const pct1h = (cw1h / totalCw) * 100;
    if (pct1h >= 5) {
      out.push({
        level: "info",
        text: `Cache TTL mix: ${pct1h.toFixed(0)}% of cache writes used the 1h tier (more expensive but persists longer). Worthwhile if those bytes are reused across multi-hour idle gaps.`,
      });
    }
  }

  if (apiErrors.totalErrors > 0) {
    const top = apiErrors.byCode.slice(0, 4).map((e) => `${e.code} ×${e.count}`).join(", ");
    const has529 = apiErrors.byCode.some((e) => e.code === "529");
    out.push({
      level: apiErrors.totalErrors >= 10 ? "warn" : "info",
      text: `${apiErrors.totalErrors} API error${apiErrors.totalErrors === 1 ? "" : "s"} during the session: ${top}.${has529 ? " Status 529 = Anthropic capacity overload (transient, automatically retried)." : ""}`,
    });
  }

  // Read:Edit ratio — high ratio = lots of exploration, little writing.
  const readStat2 = toolStats.find((t) => t.name === "Read");
  const editStat = toolStats.find((t) => t.name === "Edit");
  const writeStat = toolStats.find((t) => t.name === "Write");
  const reads = readStat2?.calls ?? 0;
  const writes = (editStat?.calls ?? 0) + (writeStat?.calls ?? 0);
  if (reads >= 20 && writes > 0) {
    const ratio = reads / writes;
    if (ratio >= 5) {
      out.push({
        level: ratio >= 10 ? "warn" : "info",
        text: `Read:Edit ratio is ${ratio.toFixed(1)}× (${reads} Reads, ${writes} Edits/Writes). High ratio = lots of exploration without writing — common when the agent is hunting for something instead of being told where to look.`,
        action:
          'Pin the relevant files in CLAUDE.md, or front-load the user prompt with explicit file paths instead of "find where X is defined".',
      });
    }
  }

  // stop_reason distribution — flag truncations and server-tool pauses.
  const stopCounts = new Map<string, number>();
  for (const t of turns) stopCounts.set(t.stopReason, (stopCounts.get(t.stopReason) ?? 0) + 1);
  const maxTokensTurns = stopCounts.get("max_tokens") ?? 0;
  const pauseTurns = stopCounts.get("pause_turn") ?? 0;
  if (maxTokensTurns > 0) {
    out.push({
      level: "warn",
      text: `${maxTokensTurns} turn${maxTokensTurns === 1 ? "" : "s"} hit max_tokens (response truncated). Truncated responses are billed in full and often need a follow-up turn to continue, doubling the cost.`,
      action:
        "Either raise max_tokens for the relevant turns, or break complex requests into smaller sub-tasks the model can answer in one go.",
    });
  }
  if (pauseTurns > 0) {
    out.push({
      level: "info",
      text: `${pauseTurns} turn${pauseTurns === 1 ? "" : "s"} paused on server-tool iteration limit (default 10 iterations for Agent / WebSearch). Server-side sampling loop hit its cap and returned partial results.`,
    });
  }

  // Per-model cost split — useful when sessions mix Opus and Sonnet/Haiku.
  if (turns.length >= 5) {
    const byModel = new Map<string, { calls: number; cost: number }>();
    for (const t of turns) {
      const cur = byModel.get(t.model) ?? { calls: 0, cost: 0 };
      cur.calls += 1;
      cur.cost += t.costUsd;
      byModel.set(t.model, cur);
    }
    const ranked = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
    if (ranked.length >= 2) {
      const totalCost = ranked.reduce((s, [, v]) => s + v.cost, 0);
      const breakdown = ranked
        .map(([m, v]) => `${m.replace(/^claude-/, "")} $${v.cost.toFixed(2)} (${v.calls})`)
        .join(", ");
      out.push({
        level: "info",
        text: `Cost by model: ${breakdown}. Total $${totalCost.toFixed(2)} across ${ranked.length} models.`,
      });
    }
  }

  // Thinking-block output — extended thinking adds real output tokens.
  const totalOutput = turns.reduce((s, t) => s + t.usage.outputTokens, 0);
  const totalThinking = turns.reduce((s, t) => s + t.thinkingOutputTokens, 0);
  if (totalThinking > 1000 && totalOutput > 0) {
    const pct = (totalThinking / totalOutput) * 100;
    out.push({
      level: pct > 50 ? "warn" : "info",
      text: `Extended thinking output: ~${totalThinking.toLocaleString("en-US")} tokens (${pct.toFixed(0)}% of total output). Thinking blocks are billed at the output rate AND accumulate in conversation history, so they're paid for again on every subsequent turn at cache-read rate.`,
      action:
        pct > 50
          ? "Lower the effort level (or disable extended thinking) for routine work; reserve high effort for genuinely complex steps."
          : undefined,
    });
  }

  if (compactions.length > 0) {
    const where = compactions
      .map((c) => `turn #${c.afterTurnIndex ?? "?"} (${c.preTokens.toLocaleString("en-US")} tok pre)`)
      .join(", ");
    const allAuto = compactions.every((c) => c.trigger === "auto");
    out.push({
      level: "info",
      text: `${compactions.length} /compact event${compactions.length === 1 ? "" : "s"} fired (${allAuto ? "all auto, 80% threshold" : "mix of auto + manual"}): ${where}. Earlier manual /compact at semantic topic boundaries would compact while context is still focused, instead of after it gets noisy.`,
    });
  }

  // Single-model comparison: what if the whole session ran on one model?
  // This is the honest framing — switching mid-session breaks the cache so
  // per-turn routing is impractical without smart-router infrastructure.
  if (routing.actualTotal > 0.5) {
    const sonnetSave = routing.actualTotal - routing.ifAllSonnet;
    if (sonnetSave > routing.actualTotal * 0.2) {
      out.push({
        level: "info",
        text: `If this entire session had run on Sonnet instead of ${turns[0]?.model ?? "the actual model"}, est. cost would have been ~$${routing.ifAllSonnet.toFixed(2)} vs the actual $${routing.actualTotal.toFixed(2)} (~$${sonnetSave.toFixed(2)} saved).`,
        action: `Run /model sonnet at session start, or set "model" in your project .claude/settings.json. Picking once and sticking preserves cache hits.`,
      });
    }
  }
  if (subagents.totalAgents > 0) {
    const top = subagents.agents[0];
    const mainTotal = turns.reduce((s, t) => s + t.costUsd, 0);
    const grand = mainTotal + subagents.totalCostUsd;
    const pct = grand > 0 ? (subagents.totalCostUsd / grand) * 100 : 0;
    out.push({
      level: subagents.totalCostUsd > 1 ? "warn" : "info",
      text: `Hidden subagent cost: ${subagents.totalAgents} subagent${subagents.totalAgents === 1 ? "" : "s"} ran ${subagents.totalInternalTurns.toLocaleString("en-US")} internal turns costing ~$${subagents.totalCostUsd.toFixed(2)} (${pct.toFixed(1)}% of grand total). The top strip's totals don't include this — your real session cost is ~$${grand.toFixed(2)} (= $${mainTotal.toFixed(2)} main thread + $${subagents.totalCostUsd.toFixed(2)} subagents). Top subagent: ${top.internalTurns} turns, $${top.costUsd.toFixed(2)}.`,
    });
  }

  if (routing.totalSavings > 0.5) {
    const pct =
      routing.actualTotal > 0 ? (routing.totalSavings / routing.actualTotal) * 100 : 0;
    const parts: string[] = [];
    if (routing.haikuCount > 0) parts.push(`${routing.haikuCount} turns → Haiku`);
    if (routing.sonnetCount > 0) parts.push(`${routing.sonnetCount} turns → Sonnet`);
    out.push({
      level: "info",
      text: `Per-turn routing potential: ~$${routing.totalSavings.toFixed(2)} (${pct.toFixed(1)}% of total) — ${parts.join(", ")} — flagged by short-output + no-Skill/Agent heuristic. Caveat: in practice, switching mid-session breaks the prompt cache (~50K-token re-upload per switch), so real savings only materialize with a router that preserves the cached prefix across models.`,
    });
  }

  return out;
}

export function treemapForTurn(turn: Turn): EChartsOption {
  const totalIn =
    turn.usage.inputTokens + turn.usage.cacheCreationTokens + turn.usage.cacheReadTokens;
  const subjectClip = turn.userPromptPreview.length > 90
    ? turn.userPromptPreview.slice(0, 89) + "…"
    : turn.userPromptPreview;
  const toolsLine = turn.toolsCalled.length > 0
    ? `tools: ${turn.toolsCalled.slice(0, 6).join(", ")}${turn.toolsCalled.length > 6 ? "…" : ""}`
    : "no tool calls";
  return {
    title: {
      text: `Turn #${turn.index}: ${totalIn.toLocaleString("en-US")} input tokens · $${turn.costUsd.toFixed(4)}`,
      subtext: `"${subjectClip}"  ·  ${toolsLine}`,
      left: "center",
      textStyle: { color: "#e6edf3", fontSize: 14 },
      subtextStyle: { color: "#8b949e", fontSize: 12 },
    },
    tooltip: {
      formatter: (info: { name: string; value: number; data?: { kind?: SourceKind } }) =>
        `<b>${info.name}</b><br/>${info.value.toLocaleString("en-US")} tokens (${((info.value / totalIn) * 100).toFixed(1)}%)`,
    },
    series: [
      {
        type: "treemap",
        roam: false,
        breadcrumb: { show: false },
        label: {
          show: true,
          formatter: (p: { name: string; value: number }) =>
            `${p.name}\n${p.value.toLocaleString("en-US")} tok`,
          color: "#fff",
          fontSize: 12,
        },
        upperLabel: { show: false },
        itemStyle: { borderColor: "#0d1117", borderWidth: 2, gapWidth: 2 },
        data: turn.sources.map((s: Source) => ({
          name: s.name,
          value: s.tokens,
          kind: s.kind,
          itemStyle: { color: KIND_COLORS[s.kind] },
        })),
      },
    ],
  };
}

export function stackedAreaAcrossTurns(turns: Turn[]): EChartsOption {
  const buckets = bucketize(turns);
  const bucketed = buckets.length < turns.length;
  const titleSuffix = bucketed ? `  ·  ${buckets[0].turns.length} turns/bucket (mean per turn)` : "";
  const xs = buckets.map((b) => b.label);
  const seriesByKind = new Map<SourceKind, number[]>();
  for (const k of KIND_ORDER) seriesByKind.set(k, new Array(buckets.length).fill(0));
  for (let i = 0; i < buckets.length; i++) {
    const sub = buckets[i].turns;
    const totalsByKind = new Map<SourceKind, number>();
    for (const t of sub) {
      for (const s of t.sources) {
        totalsByKind.set(s.kind, (totalsByKind.get(s.kind) ?? 0) + s.tokens);
      }
    }
    for (const [kind, total] of totalsByKind) {
      const arr = seriesByKind.get(kind);
      if (arr) arr[i] = Math.round(total / sub.length);
    }
  }
  return {
    title: {
      text: "Token attribution across turns" + titleSuffix,
      left: "center",
      textStyle: { color: "#e6edf3" },
    },
    tooltip: { trigger: "axis" },
    legend: {
      data: KIND_ORDER.map((k) => KIND_LABELS[k]),
      top: 28,
      textStyle: { color: "#e6edf3" },
    },
    grid: { left: 60, right: 30, top: 70, bottom: 50 },
    xAxis: { type: "category", data: xs, name: "turn", axisLabel: { color: "#8b949e" } },
    yAxis: { type: "value", name: "tokens", axisLabel: { color: "#8b949e" } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 20, bottom: 10 }],
    series: KIND_ORDER.map((k) => ({
      name: KIND_LABELS[k],
      type: "line",
      stack: "attr",
      areaStyle: { opacity: 0.85 },
      symbol: "none",
      itemStyle: { color: KIND_COLORS[k] },
      lineStyle: { width: 0 },
      emphasis: { focus: "series" },
      data: seriesByKind.get(k),
    })),
  };
}

export function toolUsageChart(stats: ToolStat[]): EChartsOption {
  const top = stats.slice(0, 20);
  return {
    title: { text: "Tool result tokens by tool", left: "center", textStyle: { color: "#e6edf3" } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: { name: string; value: number; dataIndex: number }[]) => {
        const idx = params[0]?.dataIndex ?? 0;
        const s = top[idx];
        return `<b>${s.name}</b><br/>Result tokens: ${s.resultTokens.toLocaleString("en-US")}<br/>Calls: ${s.calls}<br/>Mean: ${s.meanResultTokens.toLocaleString("en-US")} tok/call<br/>Max: ${s.maxResultTokens.toLocaleString("en-US")} tok`;
      },
    },
    grid: { left: 130, right: 30, top: 40, bottom: 30 },
    xAxis: { type: "value", name: "tokens", axisLabel: { color: "#8b949e" } },
    yAxis: {
      type: "category",
      data: top.map((s) => s.name).reverse(),
      axisLabel: { color: "#e6edf3" },
    },
    series: [
      {
        type: "bar",
        itemStyle: { color: "#d29922" },
        data: top.map((s) => s.resultTokens).reverse(),
        label: {
          show: true,
          position: "right",
          color: "#8b949e",
          formatter: (p: { value: number; dataIndex: number }) => {
            const s = top[top.length - 1 - p.dataIndex];
            return `${s.calls} calls`;
          },
        },
      },
    ],
  };
}

type Bin = { label: string; max: number; color: string };
const GAP_BINS: Bin[] = [
  { label: "<10s", max: 10_000, color: "#3fb950" },
  { label: "10s-1m", max: 60_000, color: "#7cc777" },
  { label: "1-5m", max: 300_000, color: "#d29922" },
  { label: "5-15m", max: 900_000, color: "#f85149" },
  { label: "15m-1h", max: 3_600_000, color: "#a40e26" },
  { label: ">1h", max: Infinity, color: "#62050f" },
];

export function idleGapHistogramChart(wc: WallClock): EChartsOption {
  const counts = GAP_BINS.map(() => 0);
  for (const g of wc.gaps) {
    for (let i = 0; i < GAP_BINS.length; i++) {
      if (g.ms < GAP_BINS[i].max) {
        counts[i]++;
        break;
      }
    }
  }
  return {
    title: {
      text: "Time between turns",
      subtext: `${wc.gaps.length} gaps · median ${formatDuration(wc.medianGapMs)} · max ${formatDuration(wc.maxGapMs)} · ${wc.longGapsCount} exceed the 5-min cache TTL`,
      left: "center",
      textStyle: { color: "#e6edf3" },
      subtextStyle: { color: "#8b949e", fontSize: 12 },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: { dataIndex: number; value: number }[]) => {
        const idx = params[0]?.dataIndex ?? 0;
        const bin = GAP_BINS[idx];
        const pct = wc.gaps.length > 0 ? (100 * counts[idx]) / wc.gaps.length : 0;
        return `<b>${bin.label}</b><br/>${counts[idx]} gaps (${pct.toFixed(1)}%)`;
      },
    },
    grid: { left: 60, right: 30, top: 70, bottom: 50 },
    xAxis: {
      type: "category",
      data: GAP_BINS.map((b) => b.label),
      name: "gap",
      axisLabel: { color: "#8b949e" },
    },
    yAxis: { type: "value", name: "gaps", axisLabel: { color: "#8b949e" } },
    series: [
      {
        type: "bar",
        data: counts.map((c, i) => ({ value: c, itemStyle: { color: GAP_BINS[i].color } })),
        label: { show: true, position: "top", color: "#e6edf3" },
      },
    ],
  };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function repeatedCallsChart(stats: RepeatedCallStat[], title: string, emptyText: string): EChartsOption {
  if (stats.length === 0) {
    return {
      title: {
        text: title,
        subtext: emptyText,
        left: "center",
        textStyle: { color: "#e6edf3" },
        subtextStyle: { color: "#8b949e" },
      },
    };
  }
  const top = stats.slice(0, 15);
  // Truncate long file paths to last 40 chars for readability.
  const labels = top.map((s) => (s.target.length > 40 ? "…" + s.target.slice(-39) : s.target));
  return {
    title: { text: title, left: "center", textStyle: { color: "#e6edf3" } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: { dataIndex: number }[]) => {
        const idx = params[0]?.dataIndex ?? 0;
        const s = top[idx];
        const wasted = Math.round((s.totalTokens * (s.calls - 1)) / s.calls);
        return (
          `<b>${s.target}</b><br/>` +
          `Calls: ${s.calls}<br/>` +
          `Total tokens: ${s.totalTokens.toLocaleString("en-US")}<br/>` +
          `Wasted (calls 2..N): ~${wasted.toLocaleString("en-US")}<br/>` +
          `Tools: ${s.tools.join(", ")}`
        );
      },
    },
    grid: { left: 280, right: 40, top: 40, bottom: 30 },
    xAxis: { type: "value", name: "tokens", axisLabel: { color: "#8b949e" } },
    yAxis: {
      type: "category",
      data: labels.slice().reverse(),
      axisLabel: { color: "#e6edf3", fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        itemStyle: { color: "#f85149" },
        data: top.map((s) => s.totalTokens).reverse(),
        label: {
          show: true,
          position: "right",
          color: "#8b949e",
          formatter: (p: { dataIndex: number }) => {
            const s = top[top.length - 1 - p.dataIndex];
            return `${s.calls}×`;
          },
        },
      },
    ],
  };
}

export function buildReportData(
  turns: Turn[],
  toolStats: ToolStat[],
  repeated: RepeatedCallStats,
  wc: WallClock,
  apiErrors: ApiErrorStats,
  compactions: CompactionEvent[],
  routing: ModelRouting,
  subagents: SubagentStats,
  config: IndexedSources,
  invokedSkills: Set<string>,
  corrections: { count: number; examples: { index: number; subject: string }[] },
): ReportData {
  const focus = turns.length > 0 ? pickFocusTurn(turns) : null;
  const focusTotal = focus
    ? focus.usage.inputTokens + focus.usage.cacheCreationTokens + focus.usage.cacheReadTokens
    : 0;
  const topTurns: TopTurnRow[] = [...turns]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
    .map((t) => {
      const totIn = t.usage.inputTokens + t.usage.cacheCreationTokens + t.usage.cacheReadTokens;
      return {
        index: t.index,
        costUsd: t.costUsd,
        totalInput: totIn,
        outputTokens: t.usage.outputTokens,
        cacheHitRate: totIn > 0 ? t.usage.cacheReadTokens / totIn : 0,
        model: t.model,
        timestamp: t.timestamp,
        subject: t.userPromptPreview,
        assistantPreview: t.assistantTextPreview,
        toolsCalled: t.toolsCalled,
      };
    });
  return {
    hero: heroData(turns, wc, routing, subagents, repeated),
    topStrip: topStripData(turns, wc),
    recommendations: generateRecommendations(
      turns,
      toolStats,
      repeated,
      wc,
      routing,
      config,
      invokedSkills,
      corrections,
    ),
    insights: generateInsights(
      turns,
      toolStats,
      repeated,
      wc,
      apiErrors,
      compactions,
      routing,
      subagents,
    ),
    tokensPerTurn: tokensPerTurnChart(turns),
    costAndCache: costAndCacheChart(turns),
    treemap: focus ? treemapForTurn(focus) : {},
    stackedArea: stackedAreaAcrossTurns(turns),
    toolUsage: toolUsageChart(toolStats),
    toolUsageRows: toolStats,
    repeatedFiles: repeatedCallsChart(
      repeated.byFile,
      "Most-touched files (read/edit/write)",
      "No file was touched more than once.",
    ),
    repeatedCommands: repeatedCallsChart(
      repeated.byCommand,
      "Most-run Bash commands",
      "No Bash command was run more than once.",
    ),
    repeatedCalls: repeated,
    idleGaps: idleGapHistogramChart(wc),
    wallClock: wc,
    modelRouting: routing,
    topTurns,
    bucketed: turns.length > MAX_X_POINTS,
    bucketSize: bucketSizeFor(turns),
    focusTurnInfo: focus
      ? { index: focus.index, costUsd: focus.costUsd, total: focusTotal }
      : { index: -1, costUsd: 0, total: 0 },
    modelTimeline: turns.map((t) => ({ index: t.index, model: t.model, timestamp: t.timestamp })),
  };
}
