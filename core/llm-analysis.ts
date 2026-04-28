// Orchestrator that runs the 5 LLM-derived features. Each feature is
// independently optional — a single failure (network blip, malformed output)
// degrades gracefully to null instead of breaking the whole report.
//
// In v0.2 (this scaffold): only the workflow narrative is fully implemented.
// The other four are stubbed with TODO + null returns so the wiring is in
// place but the prompts aren't shipping yet. Filling them in is one
// additional `llm-prompts/<feature>.ts` file each.

import type { Turn } from "./parser.js";
import {
  ollamaGenerate,
  parseJsonLoose,
  type LlmConfig,
} from "./llm.js";

export type LlmInsights = {
  /** 2–3 sentence description of how the user works in this session. */
  narrative: string | null;

  /** Counts and 1-2 example phrases per friction type. */
  frictionAnalysis: FrictionAnalysis | null;

  /** Topic-named groupings of session work (e.g. "Auth refactor"). */
  projectAreas: ProjectArea[] | null;

  /** 1-2 sentence summary of what the user wanted and whether they got it. */
  briefSummary: string | null;

  /** Outcome rating with a one-line justification. */
  outcomeRating: OutcomeRating | null;
};

export type FrictionAnalysis = {
  wrongApproach: number;
  misunderstoodRequest: number;
  excessiveChanges: number;
  examples: { type: string; turnIndex: number; quote: string }[];
};

export type ProjectArea = {
  name: string;
  description: string;
  turnIndices: number[];
};

export type OutcomeRating = {
  rating: "fully_achieved" | "mostly_achieved" | "partially_achieved" | "not_achieved";
  reason: string;
};

const EMPTY: LlmInsights = {
  narrative: null,
  frictionAnalysis: null,
  projectAreas: null,
  briefSummary: null,
  outcomeRating: null,
};

// -- Sampling helpers -----------------------------------------------------
// Most LLMs we care about have a 4–32K context. Full sessions can be 100K+
// tokens of prompts alone, so we sample: first N + last M turns plus a few
// from the cost-peak. Keeps the prompts small and cheap.

function sampleTurns(turns: Turn[], head = 8, tail = 4, peaks = 3): Turn[] {
  if (turns.length <= head + tail + peaks) return [...turns];
  const picked = new Map<number, Turn>();
  for (let i = 0; i < Math.min(head, turns.length); i++) picked.set(i, turns[i]);
  for (let i = Math.max(0, turns.length - tail); i < turns.length; i++) picked.set(i, turns[i]);
  const sortedByCost = [...turns].sort((a, b) => b.costUsd - a.costUsd).slice(0, peaks);
  for (const t of sortedByCost) picked.set(t.index, t);
  return [...picked.values()].sort((a, b) => a.index - b.index);
}

function clipPrompt(s: string, n = 140): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length <= n ? trimmed : trimmed.slice(0, n - 1) + "…";
}

function formatTurnsForPrompt(turns: Turn[]): string {
  return turns
    .map((t) => {
      const tools = t.toolsCalled.length ? `[${t.toolsCalled.slice(0, 4).join(",")}]` : "[no tools]";
      return `T#${t.index} ${tools} user: "${clipPrompt(t.userPromptPreview)}"`;
    })
    .join("\n");
}

// -- Feature 1: Workflow narrative (IMPLEMENTED) ---------------------------

const NARRATIVE_PROMPT_TEMPLATE = `You are analysing a Claude Code session transcript. Below are sample turns from the session.

{turns}

Total: {totalTurns} turns over {duration}.

Write 2–3 short sentences (max 80 words) describing how the user works with Claude Code in this session. Focus on:
- workflow shape (planning vs execution, iteration vs single-shot)
- delegation patterns (subagents, plan mode)
- correction/redirection style

Be specific and observational. No filler. No headings. No bullet points. Plain prose only.`;

function formatDurationShort(ms: number): string {
  if (ms <= 0) return "<1m";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function runWorkflowNarrative(
  turns: Turn[],
  durationMs: number,
  cfg: LlmConfig,
): Promise<string | null> {
  if (turns.length === 0) return null;
  const sample = sampleTurns(turns);
  const prompt = NARRATIVE_PROMPT_TEMPLATE
    .replace("{turns}", formatTurnsForPrompt(sample))
    .replace("{totalTurns}", String(turns.length))
    .replace("{duration}", formatDurationShort(durationMs));
  try {
    const out = await ollamaGenerate(cfg, prompt, { maxTokens: 200 });
    return out.length > 0 ? out : null;
  } catch (e) {
    console.warn(`[llm] narrative failed: ${(e as Error).message}`);
    return null;
  }
}

// -- Feature 2: Friction analysis (STUB) -----------------------------------
// TODO: prompt that asks the model to count wrong_approach / misunderstood
// / excessive_changes events with example quotes. Return JSON; parse loosely.
async function runFrictionAnalysis(
  _turns: Turn[],
  _cfg: LlmConfig,
): Promise<FrictionAnalysis | null> {
  return null;
}

// -- Feature 3: Project-area clustering (STUB) -----------------------------
// TODO: prompt that asks the model to cluster turns by topic and name them.
// For multi-session combined view, use file_path patterns to seed clusters.
async function runProjectAreas(
  _turns: Turn[],
  _cfg: LlmConfig,
): Promise<ProjectArea[] | null> {
  return null;
}

// -- Feature 4: Brief session summary (STUB) -------------------------------
// TODO: prompt that asks for a 1–2 sentence summary of what the user wanted
// and whether they got it. Use top-cost turns + first/last user prompts.
async function runBriefSummary(
  _turns: Turn[],
  _cfg: LlmConfig,
): Promise<string | null> {
  return null;
}

// -- Feature 5: Outcome rating (STUB) --------------------------------------
// TODO: prompt that returns JSON { rating, reason } using stop_reason
// distribution + final user/assistant turns + git activity (if available).
async function runOutcomeRating(
  _turns: Turn[],
  _cfg: LlmConfig,
): Promise<OutcomeRating | null> {
  return null;
}

// -- Public entry point ----------------------------------------------------

export async function analyzeWithLlm(
  turns: Turn[],
  durationMs: number,
  cfg: LlmConfig,
): Promise<LlmInsights> {
  if (!cfg.enabled) return EMPTY;
  if (turns.length === 0) return EMPTY;

  // Run sequentially for now — five small parallel requests against a single
  // local Ollama instance can OOM small models. Sequential keeps it tame.
  const narrative = await runWorkflowNarrative(turns, durationMs, cfg);
  const frictionAnalysis = await runFrictionAnalysis(turns, cfg);
  const projectAreas = await runProjectAreas(turns, cfg);
  const briefSummary = await runBriefSummary(turns, cfg);
  const outcomeRating = await runOutcomeRating(turns, cfg);

  return {
    narrative,
    frictionAnalysis,
    projectAreas,
    briefSummary,
    outcomeRating,
  };
}

// Re-export so consumers don't need to import the JSON-parse helper from llm.ts.
export { parseJsonLoose };
