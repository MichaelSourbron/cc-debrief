// Thin Ollama client. Opt-in only — the rest of cc-debrief is fully
// deterministic and never reaches this code unless --with-ollama is passed.
//
// Privacy story stays intact: Ollama runs locally (default localhost:11434),
// no API key, no upload. The user is paying with disk space + GPU/CPU,
// not with subscription tokens.

export type LlmConfig = {
  enabled: boolean;
  model: string;
  host: string; // default http://localhost:11434
  temperature: number;
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  model: "llama3.1:8b",
  host: "http://localhost:11434",
  temperature: 0.2,
};

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export type OllamaGenerateOptions = {
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
};

// Probe Ollama at the configured host. Returns true if /api/tags responds OK.
// Used by the CLI to fail-soft when the user passes --with-ollama but Ollama
// isn't actually running — better than throwing and breaking the whole report.
export async function probeOllama(cfg: LlmConfig): Promise<boolean> {
  try {
    const url = `${trimTrailingSlash(cfg.host)}/api/tags`;
    const res = await fetch(url, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

// One-shot generate. Returns the model's text output (or empty string on parse
// failure). Throws on HTTP error.
export async function ollamaGenerate(
  cfg: LlmConfig,
  prompt: string,
  options: OllamaGenerateOptions = {},
): Promise<string> {
  const url = `${trimTrailingSlash(cfg.host)}/api/generate`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    stream: false,
    options: {
      temperature: cfg.temperature,
      ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
    },
  };
  if (options.json) body.format = "json";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama request failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { response?: string };
  return (data.response ?? "").trim();
}

// Best-effort JSON parse. Some local models occasionally wrap JSON in
// ```json ... ``` fences or add prose around it; strip and retry.
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct !== null) return direct;
  // Strip code fences and surrounding prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }
  // Fall back to first {...} block.
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return tryParse(brace[0]);
  return null;
}
