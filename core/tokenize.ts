// chars/3.5 is a well-known BPE rule of thumb for English text + code.
// Within ~10% of exact tokenization for typical inputs; far more than fast
// enough for interactive use. Exact tokenization is available on demand
// (a future --precise flag) but isn't worth the per-call cost for attribution
// percentages, since the API-reported input_tokens absorbs the residual error.
const CHARS_PER_TOKEN = 3.5;

export function tokenCount(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}
