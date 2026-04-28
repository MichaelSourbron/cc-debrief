<!-- Auto-generated from 03-used-insights-as-spec.md on 2026-04-28T19:48:14.477Z. Markdown tables converted to monospace ASCII tables in fenced code blocks so they survive copy-paste into Medium. Run scripts/md-tables-to-ascii.mjs to regenerate. -->

# `/insights` vs `cc-debrief`: a feature-by-feature audit (with screenshots)

*One LLM-based, one deterministic. Same input data, different shape. Here's exactly what each tool does — the 5 features + 12 detection rules I added after running both — and the v0.2 opt-in that closes the LLM gap without sending anything anywhere.*

---

In April 2026 Anthropic shipped a built-in `/insights` slash command in Claude Code. You type `/insights`, Anthropic runs Haiku over your last 30 days of sessions, and you get an HTML report.

I'd already built [`cc-debrief`](https://github.com/MichaelSourbron/cc-debrief) — an open-source, 100% local debrief tool for the same input data. The reasonable response when a platform ships your feature is one of: archive, compete, or specialise.

I went with the third. I ran `/insights` on my own work, treated the report as a spec, and asked one question per feature: *"is this LLM-only, or could a deterministic engine do it too?"* This article shows the answers in tables.

---

## High-level comparison

```
           │ /insights (built-in)    │ cc-debrief (this tool)             
───────────┼─────────────────────────┼────────────────────────────────────
Engine     │ Haiku LLM               │ Pure deterministic, ~100 ms per    
           │                         │ session                            
Token cost │ Charges your            │ Zero                               
           │ subscription            │                                    
Privacy    │ Sends sessions through  │ 100% local, no network             
           │ the API                 │                                    
Scope      │ Last 30 days of         │ One session OR cross-session       
           │ sessions                │ combined                           
Strengths  │ Qualitative —           │ Quantitative — cache TTL, subagent 
           │ sentiment, frustration, │ split, repeated calls, idle gaps   
           │ themes                  │                                    
Weaknesses │ Costs tokens; requires  │ No qualitative analysis            
           │ API access              │                                    
```

---

## Feature coverage at a glance

Sixteen capabilities, side-by-side. Then the per-feature detail follows below.

```
Feature                     │ /insights           │ cc-debrief            
────────────────────────────┼─────────────────────┼───────────────────────
Workflow narrative & themes │ ✅                  │ ✅ opt-in             
Friction analysis           │ ✅                  │ ✅ opt-in             
(wrong_approach,            │                     │                       
misunderstood_request)      │                     │                       
Project-area clustering     │ ✅                  │ ✅ opt-in             
(Cognos / Auth / Payments)  │                     │                       
Per-session brief summary   │ ✅                  │ ✅ opt-in             
Outcome rating (fully /     │ ✅                  │ ✅ opt-in             
mostly / partially          │                     │                       
achieved)                   │                     │                       
Token attribution per turn  │ —                   │ ✅                    
Repeated reads & token      │ mentioned in        │ ✅ ranked + charted   
waste                       │ narrative           │                       
Idle gaps & cache TTL       │ neutral histogram   │ ✅ cache-killer       
                            │                     │ framing               
Hidden subagent cost        │ —                   │ ✅                    
Tool errors by category     │ ✅                  │ ✅                    
Languages touched           │ ✅                  │ ✅                    
User messages by time of    │ ✅                  │ ✅                    
day                         │                     │                       
Multi-clauding (parallel    │ ✅                  │ ✅                    
sessions)                   │                     │                       
Top expensive turns with    │ —                   │ ✅                    
prompts                     │                     │                       
Personalised "next session" │ ✅ LLM-written      │ ✅ rule-based,        
checklist                   │                     │ copy-paste            
Insights / findings with    │ ✅ qualitative      │ ✅ quantitative       
action items                │                     │                       
Privacy: 100% local, no     │ —                   │ ✅                    
API, no upload              │                     │                       
```

**Legend:** ✅ does this well · — doesn't do this · ✅ *opt-in* = available behind the `--with-ollama` flag in v0.2 (local Ollama, off by default).

The five rows marked *opt-in* are LLM-only by nature. Default `cc-debrief` skips them — that keeps the deterministic, no-network story clean. Users who want parity with `/insights` *without* sending sessions to an external API can run a local LLM via Ollama. Default behaviour is unchanged.

---

## Feature-by-feature breakdown

For each capability the LLM-based tool offers, I asked: *can a deterministic engine match it without sending sessions through an API?* The answer drove what I added.

### 1. Project-area clustering & workflow narrative

```
                        │ /insights                      │ cc-debrief     
────────────────────────┼────────────────────────────────┼────────────────
Available (default)     │ ✅                             │ —              
Available (opt-in)      │ n/a                            │ ✅ via         
                        │                                │ --with-ollama  
Mechanism               │ Haiku reads prompts, names     │ Local LLM via  
                        │ workflows                      │ Ollama — same  
                        │                                │ idea, your     
                        │                                │ machine        
Output                  │ "You operate in long,          │ Same shape,    
                        │ ambitious sessions …           │ generated      
                        │ brainstorm → spec → plan →     │ locally        
                        │ execute → review …"            │                
Could be deterministic? │ No — requires reading prose    │                
```

**Verdict:** LLM-only by nature. Default `cc-debrief` skips it (no LLM, no network). Opt-in via `--with-ollama` runs a local model to produce the same kind of narrative output without sending data anywhere — see the *v0.2 hybrid mode* section below. The other LLM-only features in the matrix above (friction analysis, brief summary, outcome rating) follow the same pattern.

---

### 2. Token attribution per turn

```
              │ /insight │ cc-debrief                                        
              │ s        │                                                   
──────────────┼──────────┼───────────────────────────────────────────────────
Available     │ ❌       │ ✅                                                
Granularity   │ n/a      │ Per-turn split: CLAUDE.md / skill listing /       
              │          │ history / this turn / system prompt residual      
Visualisation │ n/a      │ Treemap (single turn) + stacked area (across      
              │          │ turns)                                            
Use case      │ n/a      │ "Where did this $2.50 turn's tokens come from?"   
```

![cc-debrief — focus turn token attribution treemap](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/06-treemap.png)

The single most expensive turn, broken into its source attribution. The hero is the treemap. `/insights` doesn't do this — it's pure arithmetic and the LLM doesn't add anything.

---

### 3. Repeated reads & token waste

```
          │ /insights        │ cc-debrief                                 
──────────┼──────────────────┼────────────────────────────────────────────
Available │ ⚠️ Mentioned in  │ ✅ Ranked, charted, with action items      
          │ narrative        │                                            
Detection │ LLM observation  │ Walk every Read/Edit/Write tool_use, group 
          │                  │ by file_path, count                        
Output    │ "You re-read     │ 155× 36,838 tok src/database/database.ts + 
          │ database.ts a    │ the CLAUDE.md snippet to fix it            
          │ lot"             │                                            
Captures  │ Files only       │ Files and Bash commands (221× cd)          
```

![cc-debrief — repeated reads and Bash commands ranked by token waste](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/07-waste.png)

Deterministic counting wins here. Exact token-waste numbers per file, ranked, paired with a generated `## Hot files` snippet for `CLAUDE.md`.

---

### 4. Idle gaps & prompt-cache TTL

```
               │ /insights               │ cc-debrief                     
───────────────┼─────────────────────────┼────────────────────────────────
Available      │ ⚠️ User-response-time   │ ✅ Cache-killer framing (red   
               │ histogram (positive     │ bars > 5 min)                  
               │ framing)                │                                
Detection      │ n/a                     │ Inter-turn timestamp deltas,   
               │                         │ bucketed by 5-min cache TTL    
               │                         │ boundary                       
Output         │ "Median response time   │ "76 idle gaps over 5 min, max  
               │ 48s"                    │ 50h 3m — each likely expired   
               │                         │ the cache"                     
Recommendation │ None                    │ /clear instead of resuming     
               │                         │ after long breaks              
```

![cc-debrief — idle gap histogram with 5-minute cache TTL boundary](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/09-idle.png)

Same underlying data, different framing. `/insights` shows it as a neutral user-rhythm histogram; `cc-debrief` shows it as a cost signal with the 5-minute cache TTL boundary highlighted.

---

### 5. Hidden subagent cost

```
               │ /insight │ cc-debrief                                       
               │ s        │                                                  
───────────────┼──────────┼──────────────────────────────────────────────────
Available      │ ❌       │ ✅                                               
Detection      │ n/a      │ Walk progress events with agent_progress subtype,
               │          │ sum usage per agentId                            
Output         │ n/a      │ "39 subagents ran 482 internal turns costing     
               │          │ $60.53 (1.7% of grand total)"                    
Why it matters │ n/a      │ Standard tooling shows main-thread cost only;    
               │          │ subagent internals are billed separately         
```

This is one cc-debrief did first and `/insights` doesn't yet expose. Pure arithmetic on tool_use records — no LLM needed.

---

### 6. Tool errors encountered

```
               │ /insights                         │ cc-debrief           
───────────────┼───────────────────────────────────┼──────────────────────
Available      │ ✅ Bar chart by category          │ ✅ (added after the  
               │                                   │ audit)               
Categories     │ Command Failed, User Rejected,    │ Same                 
               │ File Too Large, File Changed,     │                      
               │ File Not Found, Other             │                      
Detection      │ LLM                               │ Regex bucketing on   
               │                                   │ is_error: true       
               │                                   │ tool_result payloads 
Mechanism cost │ LLM tokens                        │ Zero                 
```

![cc-debrief — tool errors by category, bucketed from is_error: true tool_results](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/13-tool-errors.png)

This was a "wait, why doesn't mine do this?" moment. The error messages are wonderfully consistent (*"File does not exist…"*, *"Exit code 2"*, *"has been modified"*) — six lines of regex, same buckets `/insights` produces, no LLM.

---

### 7. Languages touched

```
          │ /insights             │ cc-debrief                            
──────────┼───────────────────────┼───────────────────────────────────────
Available │ ✅ Bar chart by       │ ✅ (added after the audit)            
          │ language              │                                       
Detection │ LLM                   │ File-extension lookup on              
          │                       │ Read/Edit/Write file_path             
Output    │ "TypeScript: 4,789    │ "TypeScript: 18 calls / 4 files"      
          │ messages"             │                                       
```

![cc-debrief — languages touched, by file extension on Read/Edit/Write tool_use](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/14-languages.png)

Trivial deterministic add. Maps `.ts` / `.tsx` → TypeScript, `.py` → Python, etc. Counts call frequency and distinct files per language.

---

### 8. Time of day distribution

```
          │ /insights                      │ cc-debrief                   
──────────┼────────────────────────────────┼──────────────────────────────
Available │ ✅ With timezone selector      │ ✅ (added after the audit)   
Buckets   │ 4 (Morning / Afternoon /       │ 24 hours, browser-rotated by 
          │ Evening / Night)               │ TZ                           
Detection │ LLM                            │ Timestamp getUTCHours() per  
          │                                │ user message                 
```

![cc-debrief — user messages by time of day with timezone selector](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/15-time-of-day.png)

Same UX, same TZ-aware rotation, ~30 lines of code.

---

### 9. Multi-clauding (parallel sessions)

```
          │ /insights                      │ cc-debrief                   
──────────┼────────────────────────────────┼──────────────────────────────
Available │ ✅ (across last 30 days)       │ ✅ (across loaded sessions,  
          │                                │ added after the audit)       
Detection │ LLM                            │ Sweep-line over per-session  
          │                                │ [startMs, endMs] intervals   
Output    │ "8 overlap events, 14 sessions │ Same                         
          │ involved, 4% of messages"      │                              
```

![cc-debrief — multi-clauding card detecting parallel sessions across a project](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/16-multi-clauding.png)

*Synthetic data shown — 3 sessions, 2 overlapping for one hour at 37% of messages.*

This was the most interesting one to implement. Required tagging records with `__sessionId` before merging in the combined-session loader, then sweep-line to find time-overlap intervals.

```typescript
for (const sess of sorted) {
  const parsed = parseJsonl(await sess.file.text());
  const sid = sess.file.name.replace(/\.jsonl$/i, "");
  for (const r of parsed) (r as Record<string, unknown>).__sessionId = sid;
  allRecords.push(...parsed);
}
```

---

### 10. Top expensive turns with prompt context

```
          │ /insight │ cc-debrief                                            
          │ s        │                                                       
──────────┼──────────┼───────────────────────────────────────────────────────
Available │ ❌       │ ✅                                                    
Output    │ n/a      │ Sorted table: cost · input · cache hit rate · subject 
          │          │ (the user prompt) · tools called                      
Click row │ n/a      │ Expand to see assistant reply preview, model,         
          │          │ timestamp                                             
```

![cc-debrief — top 10 most expensive turns with prompt context](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/05-top-turns.png)

cc-debrief-only. *"Turn #1278 cost $16.29"* tells you nothing; *"Turn #1278 cost $16.29 — prompt was: 'refactor the entire auth module'"* tells you everything.

---

### 11. Personalised "next session" checklist

```
          │ /insights         │ cc-debrief                                
──────────┼───────────────────┼───────────────────────────────────────────
Available │ ✅ Suggested      │ ✅ 23 candidate rules → top 5 by impact   
          │ CLAUDE.md         │                                           
          │ additions,        │                                           
          │ features to try   │                                           
Mechanism │ LLM               │ Detection-only — pattern matches on       
          │                   │ existing analyzer outputs                 
Output    │ LLM-written       │ Copy-paste snippets (CLAUDE.md,           
          │ suggestions       │ settings.json, slash commands) with       
          │                   │ estimated $ / token impact                
Examples  │ "Try Custom       │ "Pin hot files (~570K tokens saved)" ·    
          │ Skills, Hooks,    │ "Cap MAX_THINKING_TOKENS (~78K shaved)" · 
          │ Task Agents"      │ "Add .claudeignore (~120K avoided)"       
```

![cc-debrief — Next session: things to try checklist with copy-paste snippets](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/04-recs.png)

The recommendation engines are the most direct comparison. Different mechanisms, similar shape, similar value.

---

### 12. Insights / auto-generated findings

```
          │ /insights           │ cc-debrief                              
──────────┼─────────────────────┼─────────────────────────────────────────
Available │ ✅ Friction         │ ✅ Behavioural insights with action     
          │ analysis ("wrong    │ items                                   
          │ approach ×20")      │                                         
Mechanism │ LLM categorisation  │ Rule-based detection on existing        
          │ of conversations    │ analyzer outputs                        
Style     │ Qualitative ("you   │ Quantitative ("Cache hit rate 99.3% —   
          │ tend to             │ excellent" / "76 idle gaps over 5 min — 
          │ over-engineer       │ cache likely expired")                  
          │ when…")             │                                         
```

![cc-debrief — auto-generated insights with action items](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/03-insights.png)

Different shape, complementary value. `/insights`' friction analysis is genuinely something only an LLM can do well. cc-debrief's insights are deterministic findings ("X happened, here's the action item").

---

### 13. Privacy & access

```
                  │ /insights           │ cc-debrief                      
──────────────────┼─────────────────────┼─────────────────────────────────
Network calls     │ ✅ Sessions sent to │ ❌ Zero                         
                  │ API                 │                                 
API key required  │ ✅                  │ ❌                              
Internet required │ ✅                  │ ❌                              
Cost per run      │ Subscription tokens │ Zero                            
Sharable report   │ Only via account    │ Static report.html, share with  
                  │                     │ anyone                          
```

For most users this column is fine for both. For regulated work, NDA'd client code, or anyone who can't send anything to a third-party API, it's a hard stop.

---

## What I added after the audit

Five deterministic things `/insights` covered that `cc-debrief` could match without dragging an LLM in:

```
# │ Feature                       │ Lines of code     
──┼───────────────────────────────┼───────────────────
1 │ Multi-clauding detection      │ ~70 (sweep-line)  
2 │ Time-of-day histogram         │ ~30               
3 │ Tool error categorisation     │ ~50 (regex switch)
4 │ Languages chart               │ ~40               
5 │ Macro stats for combined view │ ~20 (composite)   
```

Total: ~250 lines of pure analyzer code. Zero new dependencies, zero LLM calls.

## What I added optionally — `--with-ollama` (v0.2)

The five LLM-only features sat unaddressed for a few weeks while I thought about the positioning. Faking them with regex would be worse than `/insights`. Calling Anthropic's API would break the *"no API key"* tagline. The third path: **local LLM via [Ollama](https://ollama.com), gated behind a flag, off by default.**

```bash
# Install Ollama once, pull a small model:
ollama pull llama3.1:8b

# Default — unchanged, 100% deterministic, no LLM:
cc-debrief session.jsonl

# Opt-in: closes the 5 LLM-only rows above without sending data anywhere.
cc-debrief session.jsonl --with-ollama
```

**What this trades:** users who opt in pay with disk space + GPU/CPU instead of subscription tokens. The privacy story stays intact — Ollama runs locally, no API key, no upload. If Ollama isn't reachable, the CLI logs a warning and falls back to deterministic-only output.

```
Feature                             │ Default │ With --with-ollama
────────────────────────────────────┼─────────┼───────────────────
Workflow narrative & themes         │ —       │ ✅ via local LLM  
Friction analysis                   │ —       │ ✅ (coming)       
Project-area clustering             │ —       │ ✅ (coming)       
Per-session brief summary           │ —       │ ✅ (coming)       
Outcome rating                      │ —       │ ✅ (coming)       
All other 16 features in the matrix │ ✅      │ ✅ unchanged      
```

In v0.2 only the workflow narrative is fully wired; the other four are stubbed with TODOs (one extra prompt file each). They'll land before the 1.0 tag.

**Why this is the right move now and wasn't before:** when Anthropic shipped `/insights`, my first instinct was *"don't compete on LLM territory."* That was the right call for v0.1 — it forced clear positioning. But once the deterministic side of cc-debrief was sharper than `/insights`' deterministic side, the LLM-only features became the only remaining gap. Closing it as opt-in (rather than default) keeps the v0.1 pitch intact while letting users who want parity get it locally.

---

## The bonus pass: 23 detection rules in the recommendation engine

While I was inside the engine I asked the same question of the wider community: *what's been written about that I'm not detecting?* Triangulated [the GitHub issues](https://github.com/anthropics/claude-code/issues/13579), [the docs](https://code.claude.com/docs/en/best-practices), and the seemingly endless *"10 ways to cut your tokens"* posts.

Net additions — **12 new detection rules**, taking the engine from 11 → 23 candidate recommendations:

```
#        │ Rule                        │ Trigger                          
─────────┼─────────────────────────────┼──────────────────────────────────
12       │ Cap MAX_THINKING_TOKENS     │ Thinking >50% of total output    
13       │ Add .claudeignore           │ Hot files in node_modules/,      
         │                             │ dist/, build/                    
14       │ PostToolUse hook to trim    │ Bash mean >2K tok AND ≥10 calls  
         │ Bash output                 │                                  
15       │ Use 1h cache TTL            │ ≥5 long gaps AND <20% writes     
         │                             │ already 1h-tier                  
16       │ Replace vague prompts       │ ≥2 sub-30-char prompts at >3×    
         │                             │ median cost                      
17       │ Delegate to subagents       │ ≥2 turns with 4+ Reads and ≤1    
         │                             │ Edit                             
18       │ Pre-warm hot files          │ ≥3 hot files AND no project      
         │                             │ CLAUDE.md                        
19       │ Reduce output verbosity     │ Mean visible output >1500        
         │                             │ tok/turn                         
20       │ Bash command allowlist      │ Safe-prefix command with ≥10     
         │                             │ calls                            
21       │ Audit MCP servers           │ Residual share >30% of input     
22       │ PreToolUse read-once hook   │ Any file with ≥20 reads          
23       │ Restart at session          │ >5h wall-clock AND ≥150 turns    
         │ saturation                  │                                  
```

The engine still surfaces only **the top 5** ranked by estimated impact — adding 12 candidates didn't bloat the output, it improved the *selection*.

---

## The lesson

When a platform ships your feature, the right move usually isn't to fold or to fight. It's:

1. **Ask which parts of their feature are load-bearing** on its core capability — for `/insights`, that's reading prompts and naming workflows in human terms (pure LLM territory).
2. **Ask which parts are accidental** — token counts, file extensions, timestamps — things their LLM happens to also have access to but doesn't *need* to be an LLM to compute.
3. **Match the accidental parts deterministically.** Skip the load-bearing parts in v1. Write down *why* in your README.
4. **Then, when the deterministic side is sharper than theirs, close the load-bearing parts as opt-in** — for cc-debrief, via local Ollama. Default stays clean; users who want parity can have it without sending data to an external API.

That's a sharper tool *and* a clearer pitch than either *"we don't compete with the platform"* or *"we copy the platform"*.

---

**Live tool:** [michaelsourbron.github.io/cc-debrief](https://michaelsourbron.github.io/cc-debrief/)
**Source:** [github.com/MichaelSourbron/cc-debrief](https://github.com/MichaelSourbron/cc-debrief)
**License:** MIT

![cc-debrief — landing page](https://raw.githubusercontent.com/MichaelSourbron/cc-debrief/main/web/screenshots/00-drop-screen.png)

---

*`cc-debrief` is an independent, unofficial third-party project — not endorsed by or affiliated with Anthropic.*
