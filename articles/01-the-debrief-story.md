# I ran Claude Code for 9 days straight. Then I built a tool to debrief the session.

*4,167 turns later, here's what `cc-debrief` told me about my own behaviour — and what to change next time.*

---

A few weeks ago I closed a Claude Code session that had been open for nine days. 4,167 turns. One project, one long conversation, end-to-end pair-coding with Claude.

When I shut it down I realised I had no idea what had actually *happened* in there. Which files did Claude keep re-reading? How many times did the prompt cache silently expire while I went to lunch? Was my `CLAUDE.md` doing anything useful? Did those `Agent` calls I love so much actually do work, or did they spin in their own little loops? Where did the time and tokens go?

The standard tooling tells you the totals. I wanted the *post-mortem*.

So I built it. It's called **`cc-debrief`** and it does one thing: it reads your Claude Code transcripts, runs ~100 ms of pure local analysis on them, and gives you a single HTML report — *what your session actually looked like, and what to do about it next time*.

No LLM calls, no API key, no internet. Your transcripts never leave your machine.

> **Live web app:** [michaelsourbron.github.io/cc-debrief](https://michaelsourbron.github.io/cc-debrief/) — pick your `.claude` folder, see the report, no install.

Here's what it told me about my 9-day session.

---

## The headline

```
9d 4h · 4,167 turns · 99.3% cache hits · 39 subagents
```

Cache hit rate of 99.3% sounds great — and it is — until you look at the small fraction of turns that *missed* the cache, and notice they cluster around the moments I closed my laptop and came back hours later. The headline number is fine; the interesting story is in the gaps.

---

## The repeated reads

This one hurt the most, because it was so obviously fixable in hindsight:

```
repeated calls:
   155×    src/database/database.ts
   131×    src/app/conversations/ConversationsTable.tsx
    81×    src/app/analyses/PhaseEditor.tsx
   221×    Bash: cd
```

I read the same `database.ts` file **155 times** across the session. Each time, the file content went into the prompt as fresh input — Claude doesn't remember it from last turn the way *you* remember it; the file is re-discovered every time it's referenced.

The fix is laughably small: pin hot files in your project `CLAUDE.md` so Claude Code knows where they live. `cc-debrief` generates the snippet for you:

```markdown
## Hot files
- [database.ts](src/database/database.ts)
- [ConversationsTable.tsx](src/app/conversations/ConversationsTable.tsx)
- [PhaseEditor.tsx](src/app/analyses/PhaseEditor.tsx)
```

The `Bash: cd` line is its own little tragedy — 221 unnecessary `cd` commands, because Claude kept prepending `cd <project>` to git commands that didn't need it (git already operates on the working tree). Fixed in `CLAUDE.md` with one sentence.

---

## The idle gaps

Anthropic's prompt cache has a 5-minute TTL. If you walk away and come back, the next turn re-pays the price for everything you'd already cached.

`cc-debrief` shows you a histogram of inter-turn gaps and flags the cache-killers in red:

> **!** 76 idle gaps exceeded 5 minutes (max 50h 3m). Each one likely expired the prompt cache.
> → *For long breaks, prefer `/clear` and a fresh session over resuming.*

Seventy-six. The longest was over two days — me closing my laptop on Friday and resuming the same session on Monday. *Every one of those resumes paid full price for context that should have been cached.* The cheapest fix is to start fresh sessions for new days; the slightly more annoying one is `/clear` between work blocks.

---

## The hidden subagent activity

This one I genuinely did not know was happening:

> **!** Hidden subagent activity: 39 subagents ran 482 internal turns.

When you spawn an `Agent` in Claude Code, it runs its own conversation loop inside its own context. The main transcript shows you "Agent returned X" — what you don't see by default is that the agent took 12 internal turns to get there, each one with its own prompt, its own tool calls, and its own context window.

`cc-debrief` walks the agent's internal turns and surfaces them. Suddenly I could see *which* delegated tasks were one-shot lookups (3 internal turns, fine) versus the ones that turned into 20-turn rabbit-holes (worth rewriting the prompt). The same tool call viewed from outside looked identical; from inside, the gap between "Explore the codebase" and "Find the function that handles X" was huge.

---

## The full picture

Beyond those four findings, the report surfaces:

- **Top 10 most expensive turns** — with the actual user prompt that triggered each, so "turn #1278" tells you *what you were doing* at the time. Click to expand the assistant's reply.
- **Token attribution per turn** — split into `CLAUDE.md`, skill listing, conversation history, this turn's input, and the system-prompt residual. Treemap for the most expensive turn; stacked area across all turns. Now you can see *which* source grew over time and dominated context.
- **Tool result tokens by tool** — if `Read` averages >5 KB/call, a `PostToolUse` hook to trim large outputs pays off fast.
- **`stop_reason` distribution** — flags turns truncated by `max_tokens` (you got an incomplete answer) and `pause_turn` events (server-tool sampling hit its limit).
- **Extended-thinking share** — Anthropic redacts thinking text in the transcript, but it still consumes output. `cc-debrief` estimates the residual so you can see otherwise-invisible volume.
- **Correction-loop detection** — repeated *"no"*, *"still wrong"*, *"fix it"* prompts that signal a session got stuck.
- **Unused enabled skills** — skill listings consuming tokens for skills you never invoked.
- **Read:Edit ratio** — high ratio (≥5×) means Claude was hunting for files instead of being told where to look.

Fifteen distinct patterns in total, each with a copy-paste fix or actionable callout. And a **Next session — things to try** card with the top 5 ranked by impact.

---

## How to run it

Two ways. Pick one. Both produce the same report.

**Web (zero install):**

Go to [michaelsourbron.github.io/cc-debrief](https://michaelsourbron.github.io/cc-debrief/), click *Choose folder*, point at your `~/.claude` directory. The browser parses everything client-side via `FileReader` + `showDirectoryPicker`. Nothing is uploaded.

Sessions are grouped by project. Click the project name to load its most recent session; click `ALL` to combine every session of that project into one cross-session report — great for *"this file was read 380× across 5 sessions"* patterns that single-session reports miss.

**CLI:**

```bash
npx cc-debrief ~/.claude/projects/<project>/<session>.jsonl
open report.html
```

Both run locally. No LLM calls. No API key. ~100 ms per session.

---

## How does this compare to Claude Code's `/insights`?

In April 2026 Claude Code shipped a built-in `/insights` slash command that also generates an HTML session report. The two tools are complementary, not redundant.

`/insights` runs Haiku over your sessions and produces *qualitative* analysis — sentiment, frustration patterns, themes. It uses your subscription and sends sessions through the API.

`cc-debrief` is *quantitative* and *deterministic*. It tells you the exact behavioural math: cache TTL split, subagent internals, repeated-call totals, idle-gap histogram, attribution by source per turn. It hits no network, and you can share the resulting `report.html` with a teammate without exposing any conversation contents.

Use `/insights` when you want to know how a session *felt*. Use `cc-debrief` when you want to know what your session actually *did*.

---

## What I changed

After running this on three weeks of sessions, my `CLAUDE.md` grew a *Hot files* section, my workflow gained a habit of `/clear` between work blocks instead of resuming day-old sessions, and the agents I spawn are scoped tighter because I can finally see what happens inside them.

Most of those changes I "knew" I should have been doing already. Seeing my own session, broken down honestly, is what made me actually do them.

---

**Live tool:** [michaelsourbron.github.io/cc-debrief](https://michaelsourbron.github.io/cc-debrief/)
**Source:** [github.com/MichaelSourbron/cc-debrief](https://github.com/MichaelSourbron/cc-debrief)
**License:** MIT

If you've ever closed a long Claude Code session and wondered what just happened in there, run `cc-debrief` on the transcript. It takes ten seconds. You will see things you did not know about your own behaviour.

---

*`cc-debrief` is an independent, unofficial third-party project — not endorsed by or affiliated with Anthropic.*
