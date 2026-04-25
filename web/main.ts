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
} from "../core/parser.js";
import { tokenCount } from "../core/tokenize.js";
import { buildReportData, type ReportData } from "../core/render.js";

declare const echarts: {
  init: (el: HTMLElement, theme?: string) => { setOption: (o: unknown) => void; resize: () => void };
  getInstanceByDom: (
    el: Element,
  ) => { resize: () => void } | undefined;
};

const fmt = (n: number) => Number(n).toLocaleString("en-US");
const fmtUsd = (n: number) => "$" + Number(n).toFixed(2);
const fmtDuration = (ms: number) => {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
};
const escapeHtml = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function renderHero(h: ReportData["hero"]): void {
  document.getElementById("hero-primary-value")!.textContent = h.primaryValue;
  document.getElementById("hero-primary-label")!.textContent = h.primaryLabel;
  document.getElementById("hero-secondary-value")!.textContent = h.secondaryValue;
  document.getElementById("hero-secondary-label")!.textContent = h.secondaryLabel;
  document.getElementById("hero-tagline")!.textContent = h.tagline;
}

function renderStrip(s: ReportData["topStrip"]): void {
  type Cell = { label: string; value: string; sub?: string; warn?: boolean };
  const cells: Cell[] = [
    { label: "Turns", value: fmt(s.turns) },
    {
      label: "Total cost",
      value: fmtUsd(s.costUsd),
      sub: s.cacheHitRate >= 0.85 ? "cache hit good" : "cache hit low",
    },
    { label: "Input tokens", value: fmt(s.totalInputTokens) },
    { label: "Output tokens", value: fmt(s.outputTokens) },
    {
      label: "Cache hit rate",
      value: (s.cacheHitRate * 100).toFixed(1) + "%",
      sub: s.cacheHitRate >= 0.85 ? "" : "below 85% — investigate",
      warn: s.cacheHitRate < 0.85,
    },
    {
      label: "Models",
      value: String(s.models.length),
      sub: s.modelSwitches > 0 ? s.modelSwitches + " switches" : "no switches",
      warn: s.modelSwitches > 0,
    },
    {
      label: "Wall clock",
      value: fmtDuration(s.wallClockMs),
      sub: s.maxGapMs > 0 ? "max gap " + fmtDuration(s.maxGapMs) : "",
    },
    {
      label: "Idle gaps >5 min",
      value: String(s.longGapsCount),
      sub: s.longGapsCount > 0 ? "cache likely expired" : "cache stayed warm",
      warn: s.longGapsCount > 0,
    },
  ];
  document.getElementById("stats")!.innerHTML = cells
    .map(
      (c) =>
        '<div class="stat"><div class="stat-label">' + c.label + "</div>" +
        '<div class="stat-value' + (c.warn ? " warn" : "") + '">' + c.value + "</div>" +
        (c.sub ? '<div class="stat-sub">' + c.sub + "</div>" : "") + "</div>",
    )
    .join("");
}

function renderInsights(items: ReportData["insights"]): void {
  const ul = document.getElementById("insights-list")!;
  ul.innerHTML = items
    .map((it) => {
      const action = it.action ? '<div class="action">' + escapeHtml(it.action) + "</div>" : "";
      return '<li class="' + it.level + '">' + escapeHtml(it.text) + action + "</li>";
    })
    .join("");
  const warns = items.filter((i) => i.level === "warn").length;
  document.getElementById("insights-summary")!.textContent =
    items.length + " findings" + (warns > 0 ? " · " + warns + " warning" + (warns === 1 ? "" : "s") : "");
}

function renderRecommendations(recs: ReportData["recommendations"]): void {
  const summary = document.getElementById("recs-summary")!;
  if (!recs || recs.length === 0) {
    document.querySelector("#recs .card-body")!.innerHTML =
      '<div class="rec-empty">No specific recommendations — your session looks well-tuned.</div>';
    summary.textContent = "no specific recommendations";
    return;
  }
  document.getElementById("recs-list")!.innerHTML = recs
    .map((r) => {
      const snippet = r.snippet ? '<pre class="snippet">' + escapeHtml(r.snippet) + "</pre>" : "";
      return (
        "<li>" +
        '<div class="rec-title">' + escapeHtml(r.title) + "</div>" +
        '<div class="rec-pattern">' + escapeHtml(r.pattern) + "</div>" +
        '<div class="rec-why">' + escapeHtml(r.why) + "</div>" +
        snippet +
        '<div class="rec-impact">' + escapeHtml(r.estimatedImpact) + "</div>" +
        "</li>"
      );
    })
    .join("");
  summary.textContent =
    recs.length + " action" + (recs.length === 1 ? "" : "s") + " to try";
}

function renderTopTurns(rows: ReportData["topTurns"]): void {
  const tbody = document.getElementById("top-turns-body")!;
  tbody.innerHTML = rows
    .map((r, i) => {
      const ts = r.timestamp.replace("T", " ").replace(/\..*/, "");
      const tools = r.toolsCalled && r.toolsCalled.length ? r.toolsCalled.join(" · ") : "—";
      const cacheHit = (r.cacheHitRate * 100).toFixed(1) + "%";
      const summaryRow =
        '<tr class="clickable" data-row="' + i + '">' +
        "<td>#" + r.index + "</td>" +
        '<td class="num">$' + r.costUsd.toFixed(4) + "</td>" +
        '<td class="num">' + fmt(r.totalInput) + "</td>" +
        '<td class="num">' + cacheHit + "</td>" +
        '<td class="subject">' + escapeHtml(r.subject) + "</td>" +
        '<td class="tools">' + escapeHtml(tools) + "</td>" +
        "</tr>";
      const detailRow =
        '<tr class="row-detail" data-detail="' + i + '" style="display:none">' +
        '<td colspan="6">' +
        '<div class="label">Assistant reply preview</div>' +
        '<div class="reply">' +
        (r.assistantPreview ? escapeHtml(r.assistantPreview) : "<em>(no text reply — tool-only turn)</em>") +
        "</div>" +
        '<div class="label" style="margin-top:10px">Model · Timestamp</div>' +
        '<div class="muted">' + escapeHtml(r.model) + " · " + escapeHtml(ts) + "</div>" +
        "</td></tr>";
      return summaryRow + detailRow;
    })
    .join("");
  tbody.querySelectorAll("tr.clickable").forEach((tr) => {
    tr.addEventListener("click", () => {
      const i = tr.getAttribute("data-row")!;
      const detail = tbody.querySelector('tr[data-detail="' + i + '"]') as HTMLElement;
      const open = detail.style.display !== "none";
      detail.style.display = open ? "none" : "table-row";
      tr.classList.toggle("expanded", !open);
    });
  });
}

function setSummaries(d: ReportData): void {
  if (d.repeatedCalls) {
    const f = d.repeatedCalls.byFile.length;
    const c = d.repeatedCalls.byCommand.length;
    document.getElementById("waste-summary")!.textContent =
      "~" + fmt(d.repeatedCalls.totalWastedTokens) + " tok wasted · " + f + " hot files, " + c + " repeated commands";
  }
  if (d.toolUsageRows && d.toolUsageRows[0]) {
    const top = d.toolUsageRows[0];
    document.getElementById("tools-summary")!.textContent =
      "top: " + top.name + " " + fmt(top.resultTokens) + " tok / " + top.calls + " calls";
  }
  if (d.wallClock) {
    document.getElementById("idle-summary")!.textContent =
      d.wallClock.gaps.length + " gaps · " + d.wallClock.longGapsCount + " over 5 min";
  }
}

function initCharts(d: ReportData): void {
  const charts: Record<string, unknown> = {
    "chart-treemap": d.treemap,
    "chart-tools": d.toolUsage,
    "chart-rep-files": d.repeatedFiles,
    "chart-rep-cmds": d.repeatedCommands,
    "chart-idle": d.idleGaps,
    "chart-stacked": d.stackedArea,
    "chart-tokens": d.tokensPerTurn,
    "chart-cost": d.costAndCache,
  };
  for (const [id, opt] of Object.entries(charts)) {
    const el = document.getElementById(id);
    if (el && opt) echarts.init(el, "dark").setOption(opt);
  }
}

function setupInteractivity(): void {
  document.querySelectorAll<HTMLDetailsElement>("details.card").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (!d.open) return;
      d.querySelectorAll<HTMLElement>(".chart").forEach((el) => {
        const inst = echarts.getInstanceByDom(el);
        if (inst) inst.resize();
      });
    });
  });
  window.addEventListener("resize", () => {
    document.querySelectorAll<HTMLElement>(".chart").forEach((el) => {
      const inst = echarts.getInstanceByDom(el);
      if (inst) inst.resize();
    });
  });
  const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>("#toc-nav a")];
  const sections = tocLinks
    .map((a) => document.querySelector(a.getAttribute("href") ?? "#nope"))
    .filter((x): x is Element => !!x);
  const linkByHash: Record<string, HTMLAnchorElement> = Object.fromEntries(
    tocLinks.map((a) => [a.getAttribute("href")!, a]),
  );
  tocLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      const target = document.querySelector(link.getAttribute("href")!) as HTMLDetailsElement | null;
      if (target && target.tagName === "DETAILS" && !target.open) {
        target.open = true;
        target.dispatchEvent(new Event("toggle"));
        requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
        e.preventDefault();
      }
    });
  });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          tocLinks.forEach((a) => a.classList.remove("active"));
          const a = linkByHash["#" + e.target.id];
          if (a) a.classList.add("active");
        }
      }
    },
    { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
  );
  sections.forEach((s) => observer.observe(s));
}

// Walk a FileList from <input webkitdirectory> to build IndexedSources.
// Pulls user-level CLAUDE.md, plugin-cache SKILL.md files, and project CLAUDE.md.
async function buildSourcesFromFolder(
  files: FileList | null,
  sessionCwd: string | undefined,
): Promise<IndexedSources> {
  const sources: IndexedSources = { skills: [], mcpInstructions: [] };
  if (!files || files.length === 0) return sources;

  const skillFiles: File[] = [];
  let userMd: File | null = null;
  let projectMd: File | null = null;
  let settingsJson: File | null = null;
  const projectBasename = sessionCwd ? sessionCwd.split(/[\\/]/).pop() : null;

  for (const f of Array.from(files)) {
    // webkitRelativePath gives the path within the dropped folder, e.g. ".claude/skills/foo/SKILL.md"
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
    const name = f.name;
    if (name === "SKILL.md") skillFiles.push(f);
    else if (name === "CLAUDE.md") {
      // First CLAUDE.md at the dropped folder root we treat as user-level;
      // any deeper CLAUDE.md whose path mentions the project basename = project-level.
      if (projectBasename && path.toLowerCase().includes(projectBasename.toLowerCase())) {
        projectMd = f;
      } else if (!userMd) {
        userMd = f;
      }
    } else if (name === "settings.json" && path.includes(".claude")) {
      settingsJson = f;
    }
  }

  if (userMd) {
    const text = await userMd.text();
    sources.claudeMdUser = {
      path: (userMd as File & { webkitRelativePath?: string }).webkitRelativePath ?? userMd.name,
      tokens: tokenCount(text),
    };
  }
  if (projectMd) {
    const text = await projectMd.text();
    sources.claudeMdProject = {
      path: (projectMd as File & { webkitRelativePath?: string }).webkitRelativePath ?? projectMd.name,
      tokens: tokenCount(text),
    };
  }

  // Determine which plugins are enabled (skip if no settings.json found).
  let enabledPluginPrefixes: string[] = [];
  if (settingsJson) {
    try {
      const cfg = JSON.parse(await settingsJson.text()) as {
        enabledPlugins?: Record<string, boolean>;
      };
      enabledPluginPrefixes = Object.entries(cfg.enabledPlugins ?? {})
        .filter(([, on]) => !!on)
        .map(([k]) => {
          const [name, marketplace] = k.split("@");
          return `${marketplace}/${name}`;
        });
    } catch {
      /* ignore */
    }
  }

  for (const f of skillFiles) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
    // Keep skills under /skills/* (user-level) or under any enabled plugin prefix.
    const isUserSkill = /[\\/]\.?claude[\\/]skills[\\/]/.test(path) || /^skills[\\/]/.test(path);
    const isEnabledPlugin = enabledPluginPrefixes.some((pref) => path.includes(pref));
    if (!isUserSkill && !isEnabledPlugin && enabledPluginPrefixes.length > 0) continue;
    const text = await f.text();
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let name = path;
    let description = "";
    if (fm) {
      const stripQ = (s: string) => s.trim().replace(/^["']|["']$/g, "");
      const nm = fm[1].match(/^name:\s*(.+)$/m);
      const dm = fm[1].match(/^description:\s*(.+)$/m);
      if (nm) name = stripQ(nm[1]);
      if (dm) description = stripQ(dm[1]);
    }
    const listing = `- ${name}: ${description}\n`;
    sources.skills.push({ name, path, tokens: tokenCount(listing) });
  }
  sources.skills.sort((a, b) => a.name.localeCompare(b.name));
  return sources;
}

async function processInput(jsonlFile: File, configFiles: FileList | null): Promise<void> {
  setError("");
  const text = await jsonlFile.text();
  const records = parseJsonl(text);
  const sessionCwd = findSessionCwd(records);
  const sources = await buildSourcesFromFolder(configFiles, sessionCwd);
  const turns = buildTurns(records, sources);
  if (turns.length === 0) {
    setError("No assistant turns with usage blocks found in this file.");
    return;
  }
  const toolStats = analyzeToolUsage(records);
  const repeated = analyzeRepeatedCalls(records);
  const wallClock = analyzeWallClock(turns);
  const apiErrors = analyzeApiErrors(records);
  const compactions = analyzeCompactions(records, turns);
  const routing = analyzeModelRouting(turns);
  const subagents = analyzeSubagents(records);
  const invokedSkills = analyzeSkillUsage(records);
  const corrections = countCorrectionTurns(turns);

  const data = buildReportData(
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
  );

  document.getElementById("source-path")!.textContent = jsonlFile.name;
  renderHero(data.hero);
  renderStrip(data.topStrip);
  renderInsights(data.insights);
  renderRecommendations(data.recommendations);
  renderTopTurns(data.topTurns);
  setSummaries(data);
  initCharts(data);
  setupInteractivity();

  document.body.classList.add("has-data");
  window.scrollTo({ top: 0 });
}

function setError(msg: string): void {
  const el = document.getElementById("drop-err")!;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function reset(): void {
  document.body.classList.remove("has-data");
  setError("");
  // Reset file inputs so the same file can be re-selected.
  (document.getElementById("file-input") as HTMLInputElement).value = "";
  (document.getElementById("folder-input") as HTMLInputElement).value = "";
}

function pickJsonlFromList(list: FileList | File[] | null): File | null {
  if (!list) return null;
  const arr = Array.from(list);
  return arr.find((f) => f.name.endsWith(".jsonl")) ?? null;
}

function init(): void {
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const folderInput = document.getElementById("folder-input") as HTMLInputElement;
  const dropArea = document.getElementById("drop-area")!;
  const resetBtn = document.getElementById("reset-btn")!;

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (f) await processInput(f, null).catch((e) => setError(String(e?.message ?? e)));
  });

  folderInput.addEventListener("change", async () => {
    const list = folderInput.files;
    const jsonl = pickJsonlFromList(list);
    if (!jsonl) {
      setError(
        "No .jsonl file found in the selected folder. Tip: drop the project folder OR pair a .jsonl drop with a .claude folder drop.",
      );
      return;
    }
    await processInput(jsonl, list).catch((e) => setError(String(e?.message ?? e)));
  });

  resetBtn.addEventListener("click", reset);

  ["dragenter", "dragover"].forEach((ev) =>
    dropArea.addEventListener(ev, (e) => {
      e.preventDefault();
      dropArea.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropArea.addEventListener(ev, (e) => {
      e.preventDefault();
      dropArea.classList.remove("over");
    }),
  );
  dropArea.addEventListener("drop", async (e) => {
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    const files = dt.files;
    const jsonl = pickJsonlFromList(files);
    if (!jsonl) {
      setError("Drop didn't include a .jsonl file. Use the folder picker for .claude/ folders.");
      return;
    }
    await processInput(jsonl, files.length > 1 ? files : null).catch((err) =>
      setError(String(err?.message ?? err)),
    );
  });
  // Document-wide drop also accepted (covers misses outside the dotted box).
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (document.body.classList.contains("has-data")) return;
    if ((e.target as HTMLElement)?.closest("#drop-area")) return;
    e.preventDefault();
    const files = (e as DragEvent).dataTransfer?.files;
    const jsonl = pickJsonlFromList(files ?? null);
    if (jsonl) {
      processInput(jsonl, files && files.length > 1 ? files : null).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    }
  });
}

init();
