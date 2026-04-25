# cc-debrief

Post-session debrief for Claude Code transcripts.

`ccusage` tells you how much you spent. `cc-debrief` tells you *where* — which CLAUDE.md, which skill listing, which conversation history, which repeated `Read` of which file, where idle gaps expired the prompt cache — and what to do about it next session.

## Two ways to use it

### CLI (terminal users)

```
npx cc-debrief <session.jsonl>          # no install
# or
npm install -g cc-debrief
cc-debrief <session.jsonl> [--out report.html]
```

Generates a self-contained `report.html` in the current directory.

### Web (drag-and-drop)

```
npm install
npm run build:web
start web/dist/index.html         # double-click, or open with any browser
```

Drop a `.jsonl` onto the page and the same report renders in-browser.
For full attribution (CLAUDE.md + skill listing), pick your `.claude/`
folder via the "Choose .claude/ folder" button — modern browsers walk
the directory client-side. Nothing is uploaded anywhere.

Both produce identical reports because they share the same `core/` parsing + analysis + render code.

Session JSONL files live at `~/.claude/projects/<project>/<session>.jsonl` (Linux/macOS) or `%USERPROFILE%\.claude\projects\<project>\<session>.jsonl` (Windows).

### Deploy the web version

The `web/dist/` directory after `npm run build:web` is two static files (~64 KB total). Drop them on any static host:

- **GitHub Pages**: copy `web/dist/*` into a `docs/` folder on `main`, enable Pages → "Deploy from branch: main /docs". Live at `https://<user>.github.io/cc-debrief/`.
- **Cloudflare Pages / Netlify / Vercel**: connect the repo, set build command `npm run build:web`, output dir `web/dist`. Auto-deploys on every push.

## What the report shows

- **Hero** — the headline number, the biggest opportunity, and a one-line tagline of the session.
- **Stat strip** — turns, total cost, input/output tokens, cache hit rate, model switches, wall-clock span, idle gaps over 5 minutes.
- **Insights panel** — auto-generated findings with action items: most expensive turn, top tool, repeated-read warnings, idle-gap warnings, model-switch warnings, /compact events, API errors, cache TTL mix, hidden subagent cost.
- **Next session — things to try** — a personalized checklist of up to 5 actions for *this* session, each with a copy-paste snippet (CLAUDE.md, settings.json, slash command) and an estimated impact.
- **Top 10 most expensive turns** — sortable table with the user prompt that triggered each turn, the tools called, and an expandable assistant reply preview.
- **Focus turn — token attribution** — treemap of source breakdown for the most expensive turn (CLAUDE.md, skill listing, conversation history, this-turn input, system prompt + tool schemas residual).
- **Token waste from repeated calls** — ranked bars: hot files (read/edit/write multiple times) and Bash commands run multiple times.
- **Tool result tokens by tool** — horizontal bar chart, hover for mean / max per call.
- **Time between turns** — histogram bucketed by gap size, with cache-expiry-relevant gaps colored red.
- **Token attribution across turns** — stacked area, bucketed for long sessions.
- **Tokens per turn** — stacked bar (cache_read / cache_creation / new input / output), bucketed for long sessions.
- **Cost vs cache hit rate** — dual-axis bars + line.

## What attribution covers

Per-turn input tokens are attributed to:

- `CLAUDE.md` (user-level + project-level, tokenized once at session start).
- `Skill listing` — name + description per enabled skill (full skill bodies show up in conversation history if invoked).
- `Conversation history` — sum of prior message + tool_result content.
- `This turn — user message` and `This turn — tool results` — new content this turn introduced.
- `System prompt + tool schemas (residual)` — total minus everything above.

Token counts use a `chars / 3.5` BPE estimate for speed; the API-reported `input_tokens` is exact and absorbs the residual error. Pricing applies the correct 5m vs 1h TTL rates for cache writes.

## Privacy

Runs entirely locally. No LLM calls, no internet, no API key. Your transcripts and the generated `report.html` stay on your machine.

## License

MIT — see [LICENSE](./LICENSE).
