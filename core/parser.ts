import { tokenCount } from "./tokenize.js";

export type SourceKind =
  | "static-system"
  | "claude-md-user"
  | "claude-md-project"
  | "skill-listing"
  | "history"
  | "this-turn-user"
  | "this-turn-tool-result";

export type Source = {
  name: string;
  kind: SourceKind;
  path?: string;
  tokens: number;
  cached: boolean;
};

export type TurnUsage = {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export type Turn = {
  index: number;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  model: string;
  usage: TurnUsage;
  sources: Source[];
  costUsd: number;
  userPromptPreview: string;
  assistantTextPreview: string;
  toolsCalled: string[];
  stopReason: string;
  thinkingOutputTokens: number;
};

export type IndexedSources = {
  claudeMdUser?: { path: string; tokens: number };
  claudeMdProject?: { path: string; tokens: number };
  skills: { name: string; path: string; tokens: number }[];
  mcpInstructions: { server: string; tokens: number }[];
  outputStyle?: { name: string; tokens: number };
};

type Pricing = {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWrite5mPerMtok: number;
  cacheWrite1hPerMtok: number;
};

// Anthropic pricing reference: cache read = 0.1× input, 5m write = 1.25× input,
// 1h write = 2× input. Falls back to Sonnet for unknown models.
const PRICING: Record<string, Pricing> = {
  opus: {
    inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5,
    cacheWrite5mPerMtok: 18.75, cacheWrite1hPerMtok: 30,
  },
  sonnet: {
    inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3,
    cacheWrite5mPerMtok: 3.75, cacheWrite1hPerMtok: 6,
  },
  haiku: {
    inputPerMtok: 0.25, outputPerMtok: 1.25, cacheReadPerMtok: 0.025,
    cacheWrite5mPerMtok: 0.3125, cacheWrite1hPerMtok: 0.5,
  },
};

function pricingFor(model: string): Pricing {
  const m = model.toLowerCase();
  if (m.includes("opus")) return PRICING.opus;
  if (m.includes("haiku")) return PRICING.haiku;
  return PRICING.sonnet;
}

function costFor(usage: TurnUsage, model: string): number {
  const p = pricingFor(model);
  // If we have the TTL split, use it; otherwise fall back to 5m rate for the
  // total (matches old behavior on records that don't expose the split).
  const cw5 = usage.cacheCreation5mTokens;
  const cw1h = usage.cacheCreation1hTokens;
  const cwUnsplit = usage.cacheCreationTokens - cw5 - cw1h;
  return (
    (usage.inputTokens * p.inputPerMtok +
      cw5 * p.cacheWrite5mPerMtok +
      cw1h * p.cacheWrite1hPerMtok +
      cwUnsplit * p.cacheWrite5mPerMtok +
      usage.cacheReadTokens * p.cacheReadPerMtok +
      usage.outputTokens * p.outputPerMtok) /
    1_000_000
  );
}

export function recomputeCost(usage: TurnUsage, model: string): number {
  return costFor(usage, model);
}

export function parseJsonl(text: string): unknown[] {
  const records: unknown[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      console.warn(`parseJsonl: skipping malformed line ${i + 1}`);
    }
  }
  return records;
}

type MaybeRecord = Record<string, unknown> | null | undefined;

function asRecord(v: unknown): MaybeRecord {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

// Pull all text-ish content out of a record so we can tokenize it.
// Splits assistant content into text vs thinking so we can attribute the
// thinking-output cost separately.
function extractText(record: unknown): {
  user: string;
  toolResult: string;
  assistantText: string;
  assistantThinking: string;
} {
  const out = { user: "", toolResult: "", assistantText: "", assistantThinking: "" };
  const r = asRecord(record);
  if (!r) return out;
  const m = asRecord(r.message);
  if (!m) return out;
  const role = m.role;
  const content = m.content;

  const collectAssistant = (block: unknown) => {
    const b = asRecord(block);
    if (!b) return;
    if (b.type === "text" && typeof b.text === "string") out.assistantText += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string")
      out.assistantThinking += b.thinking;
    else if (b.type === "tool_use") out.assistantText += JSON.stringify(b.input ?? "");
  };
  const collectUser = (block: unknown) => {
    if (typeof block === "string") {
      out.user += block;
      return;
    }
    const b = asRecord(block);
    if (!b) return;
    if (b.type === "text" && typeof b.text === "string") out.user += b.text;
    else if (b.type === "tool_result") {
      const c = b.content;
      if (typeof c === "string") out.toolResult += c;
      else if (Array.isArray(c)) {
        for (const sub of c) {
          const s = asRecord(sub);
          if (s && s.type === "text" && typeof s.text === "string") out.toolResult += s.text;
        }
      }
    }
  };

  if (typeof content === "string") {
    if (role === "assistant") out.assistantText += content;
    else out.user += content;
  } else if (Array.isArray(content)) {
    if (role === "assistant") for (const b of content) collectAssistant(b);
    else for (const b of content) collectUser(b);
  }
  return out;
}

type RawAssistantRecord = {
  type: "assistant";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  requestId?: string;
  message: {
    model: string;
    stop_reason?: string;
    usage: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
};

function isAssistantTurn(r: unknown): r is RawAssistantRecord {
  const o = asRecord(r);
  if (!o || o.type !== "assistant") return false;
  const m = asRecord(o.message);
  return !!m && typeof m.usage === "object" && m.usage !== null;
}

// Extract the human-typed text from a user record. Returns null if the record
// is purely a tool_result continuation (no real prompt text).
function extractUserPromptText(record: unknown): string | null {
  const r = asRecord(record);
  if (!r || r.type !== "user") return null;
  const m = asRecord(r.message);
  if (!m) return null;
  const content = m.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const b of content) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text.trim() || null;
}

function summarizeAssistant(record: RawAssistantRecord): {
  text: string;
  tools: string[];
} {
  const out = { text: "", tools: [] as string[] };
  const content = (record.message as unknown as { content?: unknown }).content;
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") out.text += block.text;
    else if (block.type === "tool_use" && typeof block.name === "string")
      out.tools.push(block.name);
  }
  return out;
}

function clip(s: string, n: number): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n - 1) + "…";
}

export type ToolStat = {
  name: string;
  resultTokens: number;
  calls: number;
  meanResultTokens: number;
  maxResultTokens: number;
};

export type RepeatedCallStat = {
  target: string;
  totalTokens: number;
  calls: number;
  tools: string[];
};

export type RepeatedCallStats = {
  byFile: RepeatedCallStat[];
  byCommand: RepeatedCallStat[];
  totalWastedTokens: number;
};

export type ModelRecommendation = {
  turnIndex: number;
  currentModel: string;
  recommendedModel: string;
  currentCost: number;
  projectedCost: number;
  savings: number;
  reason: string;
  subject: string;
};

export type ModelRouting = {
  recommendations: ModelRecommendation[];
  haikuCount: number;
  sonnetCount: number;
  totalSavings: number;
  totalEligibleCost: number;
  // What the whole session would have cost if every turn ran on a single model.
  ifAllSonnet: number;
  ifAllHaiku: number;
  actualTotal: number;
};

const REASONING_TOOLS = new Set(["Agent", "Skill"]);

// Conservative downgrade heuristic: only flag turns with short outputs AND no
// reasoning-style tool calls (Agent/Skill). Avoids the noise of suggesting a
// downgrade on turns that did real reasoning work.
function suggestDowngrade(t: Turn): { model: string; reason: string } | null {
  const m = t.model.toLowerCase();
  if (!m.includes("opus") && !m.includes("sonnet")) return null;
  if (t.toolsCalled.some((tn) => REASONING_TOOLS.has(tn))) return null;
  const out = t.usage.outputTokens;
  if (out < 30) {
    return { model: "claude-haiku-4-5", reason: "trivial output, no reasoning tools" };
  }
  if (out < 200 && m.includes("opus")) {
    return { model: "claude-sonnet-4-6", reason: "short output, no reasoning tools" };
  }
  return null;
}

export function analyzeModelRouting(turns: Turn[]): ModelRouting {
  const recs: ModelRecommendation[] = [];
  for (const t of turns) {
    if (t.model === "<synthetic>") continue;
    const sugg = suggestDowngrade(t);
    if (!sugg) continue;
    const projected = costFor(t.usage, sugg.model);
    if (projected >= t.costUsd) continue;
    recs.push({
      turnIndex: t.index,
      currentModel: t.model,
      recommendedModel: sugg.model,
      currentCost: t.costUsd,
      projectedCost: projected,
      savings: t.costUsd - projected,
      reason: sugg.reason,
      subject: t.userPromptPreview,
    });
  }
  recs.sort((a, b) => b.savings - a.savings);
  let ifAllSonnet = 0;
  let ifAllHaiku = 0;
  let actualTotal = 0;
  for (const t of turns) {
    if (t.model === "<synthetic>") continue;
    actualTotal += t.costUsd;
    ifAllSonnet += costFor(t.usage, "claude-sonnet-4-6");
    ifAllHaiku += costFor(t.usage, "claude-haiku-4-5");
  }
  return {
    recommendations: recs,
    haikuCount: recs.filter((r) => r.recommendedModel.includes("haiku")).length,
    sonnetCount: recs.filter((r) => r.recommendedModel.includes("sonnet")).length,
    totalSavings: recs.reduce((s, r) => s + r.savings, 0),
    totalEligibleCost: recs.reduce((s, r) => s + r.currentCost, 0),
    ifAllSonnet,
    ifAllHaiku,
    actualTotal,
  };
}

export type SubagentStat = {
  agentId: string;
  internalTurns: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type SubagentStats = {
  agents: SubagentStat[];
  totalAgents: number;
  totalInternalTurns: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
};

export function analyzeSubagents(records: unknown[]): SubagentStats {
  type Acc = {
    internalTurns: number;
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  const byAgent = new Map<string, Acc>();
  const seenRequestIds = new Set<string>();

  for (const r of records) {
    const o = asRecord(r);
    if (!o || o.type !== "progress") continue;
    const data = asRecord(o.data);
    if (!data || data.type !== "agent_progress") continue;
    const agentId = typeof data.agentId === "string" ? data.agentId : null;
    if (!agentId) continue;
    const inner = asRecord(data.message);
    if (!inner || inner.type !== "assistant") continue;
    const requestId = typeof inner.requestId === "string" ? inner.requestId : null;
    if (requestId) {
      if (seenRequestIds.has(requestId)) continue;
      seenRequestIds.add(requestId);
    }
    const msg = asRecord(inner.message);
    if (!msg) continue;
    const u = asRecord(msg.usage);
    if (!u) continue;
    const model = typeof msg.model === "string" ? msg.model : "claude-sonnet-4-6";
    const cc = asRecord(u.cache_creation);
    const usage: TurnUsage = {
      inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
      cacheCreationTokens:
        typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
      cacheCreation5mTokens:
        cc && typeof cc.ephemeral_5m_input_tokens === "number"
          ? cc.ephemeral_5m_input_tokens
          : 0,
      cacheCreation1hTokens:
        cc && typeof cc.ephemeral_1h_input_tokens === "number"
          ? cc.ephemeral_1h_input_tokens
          : 0,
      cacheReadTokens:
        typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
      outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
    };
    const cost = costFor(usage, model);

    const cur: Acc =
      byAgent.get(agentId) ??
      {
        internalTurns: 0,
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    cur.internalTurns += 1;
    cur.inputTokens += usage.inputTokens;
    cur.cacheCreationTokens += usage.cacheCreationTokens;
    cur.cacheReadTokens += usage.cacheReadTokens;
    cur.outputTokens += usage.outputTokens;
    cur.costUsd += cost;
    byAgent.set(agentId, cur);
  }

  const agents = [...byAgent.entries()]
    .map(([agentId, s]) => ({ agentId, ...s }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    agents,
    totalAgents: agents.length,
    totalInternalTurns: agents.reduce((s, a) => s + a.internalTurns, 0),
    totalCacheReadTokens: agents.reduce((s, a) => s + a.cacheReadTokens, 0),
    totalCostUsd: agents.reduce((s, a) => s + a.costUsd, 0),
  };
}

export type CompactionEvent = {
  timestamp: string;
  trigger: string;
  preTokens: number;
  afterTurnIndex: number | null;
};

export function analyzeCompactions(records: unknown[], turns: Turn[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  // For mapping events back to a turn index, sort turn timestamps once.
  const turnTimes = turns.map((t, i) => ({ idx: i, ts: new Date(t.timestamp).getTime() }));
  for (const r of records) {
    const o = asRecord(r);
    if (!o || o.type !== "system" || o.subtype !== "compact_boundary") continue;
    const ts = typeof o.timestamp === "string" ? o.timestamp : "";
    if (!ts) continue;
    const cm = asRecord(o.compactMetadata) ?? {};
    const trigger = typeof cm.trigger === "string" ? cm.trigger : "(unknown)";
    const preTokens = typeof cm.preTokens === "number" ? cm.preTokens : 0;
    const tsMs = new Date(ts).getTime();
    let afterTurnIndex: number | null = null;
    for (const t of turnTimes) {
      if (t.ts <= tsMs) afterTurnIndex = turns[t.idx].index;
      else break;
    }
    events.push({ timestamp: ts, trigger, preTokens, afterTurnIndex });
  }
  return events;
}

export type ApiError = { code: string; count: number };

export type ApiErrorStats = {
  totalErrors: number;
  byCode: ApiError[];
};

export function analyzeApiErrors(records: unknown[]): ApiErrorStats {
  const counts = new Map<string, number>();
  for (const r of records) {
    const o = asRecord(r);
    if (!o) continue;
    if (o.type !== "system" || o.subtype !== "api_error") continue;
    const err = asRecord(o.error);
    const cause = err ? asRecord(err.cause) ?? err : null;
    let code: string | number | null = null;
    if (cause) {
      code =
        (typeof cause.status === "number" ? cause.status : null) ??
        (typeof cause.code === "string" ? cause.code : null) ??
        (typeof cause.errno !== "undefined" ? String(cause.errno) : null);
    }
    const key = code != null ? String(code) : "(unknown)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byCode = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
  const totalErrors = byCode.reduce((s, e) => s + e.count, 0);
  return { totalErrors, byCode };
}

export type IdleGap = { ms: number; afterTurnIndex: number };

export type WallClock = {
  totalSpanMs: number;
  startTimestamp: string | null;
  endTimestamp: string | null;
  gaps: IdleGap[];
  longGapsCount: number;
  maxGapMs: number;
  medianGapMs: number;
  totalIdleMs: number;
};

const FIVE_MIN_MS = 5 * 60 * 1000;

export function analyzeWallClock(turns: Turn[]): WallClock {
  if (turns.length < 2) {
    return {
      totalSpanMs: 0,
      startTimestamp: turns[0]?.timestamp ?? null,
      endTimestamp: turns[0]?.timestamp ?? null,
      gaps: [],
      longGapsCount: 0,
      maxGapMs: 0,
      medianGapMs: 0,
      totalIdleMs: 0,
    };
  }
  const gaps: IdleGap[] = [];
  for (let i = 1; i < turns.length; i++) {
    const ms =
      new Date(turns[i].timestamp).getTime() - new Date(turns[i - 1].timestamp).getTime();
    if (ms > 0) gaps.push({ ms, afterTurnIndex: turns[i - 1].index });
  }
  const start = turns[0].timestamp;
  const end = turns[turns.length - 1].timestamp;
  const totalSpan = new Date(end).getTime() - new Date(start).getTime();
  const sorted = [...gaps].sort((a, b) => a.ms - b.ms);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)].ms : 0;
  const longGapsCount = gaps.filter((g) => g.ms > FIVE_MIN_MS).length;
  const totalIdle = gaps.reduce((s, g) => s + g.ms, 0);
  const maxGapMs = gaps.reduce((m, g) => Math.max(m, g.ms), 0);
  return {
    totalSpanMs: totalSpan,
    startTimestamp: start,
    endTimestamp: end,
    gaps,
    longGapsCount,
    maxGapMs,
    medianGapMs: median,
    totalIdleMs: totalIdle,
  };
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

export function analyzeRepeatedCalls(records: unknown[]): RepeatedCallStats {
  const idMeta = new Map<string, { name: string; target: string }>();
  const byFile = new Map<string, { tokens: number; calls: number; tools: Set<string> }>();
  const byCommand = new Map<string, { tokens: number; calls: number }>();

  for (const r of records) {
    const o = asRecord(r);
    if (!o) continue;
    const m = asRecord(o.message);
    if (!m) continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "tool_use") {
        const id = typeof b.id === "string" ? b.id : null;
        const name = typeof b.name === "string" ? b.name : null;
        if (!id || !name) continue;
        const input = asRecord(b.input);
        let target = "";
        if (FILE_TOOLS.has(name)) {
          target = typeof input?.file_path === "string" ? input.file_path : "";
        } else if (name === "Bash") {
          const cmd = typeof input?.command === "string" ? input.command : "";
          target = cmd.trim().split(/\s+/)[0] ?? "";
        }
        if (target) idMeta.set(id, { name, target });
      } else if (b.type === "tool_result") {
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
        if (!id) continue;
        const meta = idMeta.get(id);
        if (!meta) continue;
        let text = "";
        if (typeof b.content === "string") text = b.content;
        else if (Array.isArray(b.content)) {
          for (const sub of b.content) {
            const s = asRecord(sub);
            if (s && s.type === "text" && typeof s.text === "string") text += s.text;
          }
        }
        const toks = tokenCount(text);
        if (meta.name === "Bash") {
          const cur = byCommand.get(meta.target) ?? { tokens: 0, calls: 0 };
          cur.tokens += toks;
          cur.calls += 1;
          byCommand.set(meta.target, cur);
        } else {
          const cur = byFile.get(meta.target) ?? { tokens: 0, calls: 0, tools: new Set<string>() };
          cur.tokens += toks;
          cur.calls += 1;
          cur.tools.add(meta.name);
          byFile.set(meta.target, cur);
        }
      }
    }
  }

  // "Wasted" tokens = tokens for repeated targets minus the first (unavoidable) call.
  const wasteFor = (s: { tokens: number; calls: number }) =>
    s.calls > 1 ? Math.round((s.tokens * (s.calls - 1)) / s.calls) : 0;

  const fileStats: RepeatedCallStat[] = [...byFile.entries()]
    .filter(([, s]) => s.calls > 1)
    .map(([target, s]) => ({
      target,
      totalTokens: s.tokens,
      calls: s.calls,
      tools: [...s.tools].sort(),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 20);

  const cmdStats: RepeatedCallStat[] = [...byCommand.entries()]
    .filter(([, s]) => s.calls > 1)
    .map(([target, s]) => ({
      target,
      totalTokens: s.tokens,
      calls: s.calls,
      tools: ["Bash"],
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 20);

  let totalWasted = 0;
  for (const s of byFile.values()) totalWasted += wasteFor(s);
  for (const s of byCommand.values()) totalWasted += wasteFor(s);

  return { byFile: fileStats, byCommand: cmdStats, totalWastedTokens: totalWasted };
}

// Set of skill names actually invoked (via the Skill tool) in this session.
// Compared against the enabled-skills index to surface unused-but-loaded skills.
export function analyzeSkillUsage(records: unknown[]): Set<string> {
  const invoked = new Set<string>();
  for (const r of records) {
    const o = asRecord(r);
    if (!o) continue;
    const m = asRecord(o.message);
    if (!m) continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (!b || b.type !== "tool_use" || b.name !== "Skill") continue;
      const input = asRecord(b.input);
      const name = typeof input?.skill === "string" ? input.skill.trim() : "";
      if (name) invoked.add(name);
    }
  }
  return invoked;
}

// Count user-prompt turns that look like corrections / redirections /
// expressions of frustration. A high count signals a "stuck loop" pattern
// that benefits from /clear + a rewritten prompt.
const CORRECTION_PATTERNS: RegExp[] = [
  /^(no|nope)\b/i,
  /\bstill\s+(wrong|broken|fail|doesn'?t|didn'?t|not)\b/i,
  /\b(didn'?t|doesn'?t)\s+work\b/i,
  /\b(that'?s|this is)\s+(wrong|broken|incorrect)\b/i,
  /\bnot\s+what\s+i\s+(wanted|asked|meant)\b/i,
  /\byou\s+(missed|forgot|broke|messed up)\b/i,
  /\b(fix|fixed)\s+(it|that|this)\b/i,
  /\btry\s+again\b/i,
  /\bagain\.?\s*$/i,
];

export function countCorrectionTurns(turns: Turn[]): {
  count: number;
  examples: { index: number; subject: string }[];
} {
  const examples: { index: number; subject: string }[] = [];
  for (const t of turns) {
    const text = t.userPromptPreview;
    if (!text || text === "(continuation)") continue;
    if (CORRECTION_PATTERNS.some((rx) => rx.test(text))) {
      if (examples.length < 5) examples.push({ index: t.index, subject: text });
    }
  }
  // Walk again for full count without storing all examples
  let count = 0;
  for (const t of turns) {
    const text = t.userPromptPreview;
    if (!text || text === "(continuation)") continue;
    if (CORRECTION_PATTERNS.some((rx) => rx.test(text))) count++;
  }
  return { count, examples };
}

export function analyzeToolUsage(records: unknown[]): ToolStat[] {
  const idToName = new Map<string, string>();
  const stats = new Map<string, { tokens: number; calls: number; max: number }>();

  for (const r of records) {
    const o = asRecord(r);
    if (!o) continue;
    const m = asRecord(o.message);
    if (!m) continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "tool_use") {
        const id = typeof b.id === "string" ? b.id : null;
        const name = typeof b.name === "string" ? b.name : "(unknown)";
        if (id) idToName.set(id, name);
      } else if (b.type === "tool_result") {
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
        const name = (id && idToName.get(id)) ?? "(unknown)";
        let text = "";
        if (typeof b.content === "string") text = b.content;
        else if (Array.isArray(b.content)) {
          for (const sub of b.content) {
            const s = asRecord(sub);
            if (s && s.type === "text" && typeof s.text === "string") text += s.text;
          }
        }
        const toks = tokenCount(text);
        const cur = stats.get(name) ?? { tokens: 0, calls: 0, max: 0 };
        cur.tokens += toks;
        cur.calls += 1;
        if (toks > cur.max) cur.max = toks;
        stats.set(name, cur);
      }
    }
  }

  return [...stats.entries()]
    .map(([name, s]) => ({
      name,
      resultTokens: s.tokens,
      calls: s.calls,
      meanResultTokens: s.calls > 0 ? Math.round(s.tokens / s.calls) : 0,
      maxResultTokens: s.max,
    }))
    .sort((a, b) => b.resultTokens - a.resultTokens);
}

export function findSessionCwd(records: unknown[]): string | undefined {
  for (const r of records) {
    const o = asRecord(r);
    if (o && typeof o.cwd === "string") return o.cwd;
  }
  return undefined;
}

function attribute(
  total: number,
  config: IndexedSources,
  newUserTokens: number,
  newToolResultTokens: number,
  historyTokens: number,
): Source[] {
  const sources: Source[] = [];
  const claudeMdUser = config.claudeMdUser?.tokens ?? 0;
  const claudeMdProject = config.claudeMdProject?.tokens ?? 0;
  if (claudeMdUser > 0) {
    sources.push({
      name: "CLAUDE.md (user)",
      kind: "claude-md-user",
      path: config.claudeMdUser?.path,
      tokens: claudeMdUser,
      cached: true,
    });
  }
  if (claudeMdProject > 0) {
    sources.push({
      name: "CLAUDE.md (project)",
      kind: "claude-md-project",
      path: config.claudeMdProject?.path,
      tokens: claudeMdProject,
      cached: true,
    });
  }
  const skillListingTokens = config.skills.reduce((a, s) => a + s.tokens, 0);
  if (skillListingTokens > 0) {
    sources.push({
      name: `Skill listing (${config.skills.length} skills)`,
      kind: "skill-listing",
      tokens: skillListingTokens,
      cached: true,
    });
  }
  if (historyTokens > 0) {
    sources.push({
      name: "Conversation history",
      kind: "history",
      tokens: historyTokens,
      cached: true,
    });
  }
  if (newUserTokens > 0) {
    sources.push({
      name: "This turn — user message",
      kind: "this-turn-user",
      tokens: newUserTokens,
      cached: false,
    });
  }
  if (newToolResultTokens > 0) {
    sources.push({
      name: "This turn — tool results",
      kind: "this-turn-tool-result",
      tokens: newToolResultTokens,
      cached: false,
    });
  }
  const accounted = sources.reduce((a, s) => a + s.tokens, 0);
  const residual = Math.max(0, total - accounted);
  sources.push({
    name: "System prompt + tool schemas (residual)",
    kind: "static-system",
    tokens: residual,
    cached: true,
  });
  return sources;
}

export function buildTurns(records: unknown[], config: IndexedSources): Turn[] {
  const turns: Turn[] = [];
  const seenRequestIds = new Set<string>();

  // Tokenize every record's content once; we'll re-use these counts.
  const tokensByIndex: {
    user: number;
    toolResult: number;
    assistantText: number;
    assistantThinking: number;
  }[] = records.map((r) => {
    const t = extractText(r);
    return {
      user: t.user ? tokenCount(t.user) : 0,
      toolResult: t.toolResult ? tokenCount(t.toolResult) : 0,
      assistantText: t.assistantText ? tokenCount(t.assistantText) : 0,
      assistantThinking: t.assistantThinking ? tokenCount(t.assistantThinking) : 0,
    };
  });

  let historyTokens = 0;
  let pendingUserTokens = 0;
  let pendingToolResultTokens = 0;
  let pendingUserText = "";
  let index = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const t = tokensByIndex[i];

    if (!isAssistantTurn(r)) {
      // Pre-assistant content accumulates as "this turn's new input"
      // until the next assistant turn consumes it.
      pendingUserTokens += t.user;
      pendingToolResultTokens += t.toolResult;
      const promptText = extractUserPromptText(r);
      if (promptText) pendingUserText = promptText;
      continue;
    }

    // Dedupe streaming/finalization duplicates.
    if (r.requestId) {
      if (seenRequestIds.has(r.requestId)) {
        // Even on dedupe, fold this assistant's content into history so it
        // counts for the next turn — but only once. Track separately to avoid
        // double-counting; simplest: merge here and skip turn creation.
        historyTokens += t.assistantText + t.assistantThinking;
        continue;
      }
      seenRequestIds.add(r.requestId);
    }

    const u = r.message.usage;
    const usage: TurnUsage = {
      inputTokens: u.input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      cacheCreation5mTokens: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cacheCreation1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
    };
    const total = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    const sources = attribute(
      total,
      config,
      pendingUserTokens,
      pendingToolResultTokens,
      historyTokens,
    );
    const summary = summarizeAssistant(r);

    turns.push({
      index: index++,
      uuid: r.uuid,
      parentUuid: r.parentUuid,
      timestamp: r.timestamp,
      model: r.message.model,
      usage,
      sources,
      costUsd: costFor(usage, r.message.model),
      userPromptPreview: clip(pendingUserText || "(continuation)", 200),
      assistantTextPreview: clip(summary.text, 200),
      toolsCalled: summary.tools,
      stopReason: typeof r.message.stop_reason === "string" ? r.message.stop_reason : "(none)",
      // Thinking output is often redacted by Anthropic in the JSONL (only the
      // signature is stored), so directly tokenizing thinking blocks yields 0
      // even when the model actually thought. Estimate as residual: total
      // output_tokens reported by the API minus the visible text+tool_use
      // tokens we can measure.
      thinkingOutputTokens: Math.max(0, usage.outputTokens - t.assistantText),
    });

    // Roll this turn's new input + this assistant's content into history for next turn.
    historyTokens += pendingUserTokens + pendingToolResultTokens + t.assistantText + t.assistantThinking;
    pendingUserTokens = 0;
    pendingToolResultTokens = 0;
  }
  return turns;
}
