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
  analyzeToolErrors,
  analyzeLanguages,
  analyzeTimeOfDay,
  analyzeMultiClauding,
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
  if (d.toolErrorsChart) charts["chart-tool-errors"] = d.toolErrorsChart;
  if (d.languagesChart) charts["chart-languages"] = d.languagesChart;
  for (const [id, opt] of Object.entries(charts)) {
    const el = document.getElementById(id);
    if (el && opt) echarts.init(el, "dark").setOption(opt);
  }
}

// Time-of-day chart: data is 24 UTC hour counts; user picks a timezone offset
// and we rotate the array to render local-time buckets. Re-rendered on TZ change.
function buildTimeOfDayChartOption(hourCountsUtc: number[], tzOffsetHours: number): unknown {
  const local = new Array<number>(24).fill(0);
  for (let h = 0; h < 24; h++) {
    const localHour = ((h + tzOffsetHours) % 24 + 24) % 24;
    local[localHour] = hourCountsUtc[h];
  }
  const labels = local.map((_, i) => `${String(i).padStart(2, "0")}h`);
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 50, right: 30, top: 20, bottom: 40 },
    xAxis: { type: "category", data: labels, axisLabel: { color: "#8b949e", fontSize: 10 } },
    yAxis: { type: "value", name: "messages", axisLabel: { color: "#8b949e" } },
    series: [
      {
        type: "bar",
        itemStyle: { color: "#8957e5" },
        data: local,
      },
    ],
  };
}

function renderTimeOfDay(d: ReportData): void {
  const counts = d.timeOfDay.hourCountsUtc;
  const summary = document.getElementById("time-of-day-summary")!;
  summary.textContent = `${d.timeOfDay.totalUserMessages} user message${d.timeOfDay.totalUserMessages === 1 ? "" : "s"}`;
  const select = document.getElementById("tz-select") as HTMLSelectElement | null;
  const el = document.getElementById("chart-time-of-day");
  if (!el || !select) return;
  const inst = echarts.init(el, "dark");
  const apply = () => {
    const offset = parseFloat(select.value);
    inst.setOption(buildTimeOfDayChartOption(counts, offset));
  };
  apply();
  select.addEventListener("change", apply);
}

function renderToolErrors(d: ReportData): void {
  const card = document.getElementById("tool-errors");
  const tocLink = document.getElementById("toc-tool-errors");
  if (!card) return;
  if (d.toolErrors.total === 0) {
    card.hidden = true;
    if (tocLink) tocLink.hidden = true;
    return;
  }
  card.hidden = false;
  if (tocLink) tocLink.hidden = false;
  const summary = document.getElementById("tool-errors-summary")!;
  const top = d.toolErrors.byCategory[0];
  summary.textContent = `${d.toolErrors.total} error${d.toolErrors.total === 1 ? "" : "s"} · top: ${top.label} ×${top.count}`;
}

function renderLanguages(d: ReportData): void {
  const card = document.getElementById("languages");
  const tocLink = document.getElementById("toc-languages");
  if (!card) return;
  if (d.languages.length === 0) {
    card.hidden = true;
    if (tocLink) tocLink.hidden = true;
    return;
  }
  card.hidden = false;
  if (tocLink) tocLink.hidden = false;
  const summary = document.getElementById("languages-summary")!;
  const top = d.languages[0];
  summary.textContent = `${d.languages.length} language${d.languages.length === 1 ? "" : "s"} · top: ${top.language} (${top.calls} calls, ${top.files} files)`;
}

function renderMultiClauding(d: ReportData): void {
  const card = document.getElementById("multi-clauding");
  const tocLink = document.getElementById("toc-multi-clauding");
  if (!card) return;
  if (!d.multiClauding) {
    card.hidden = true;
    if (tocLink) tocLink.hidden = true;
    return;
  }
  card.hidden = false;
  if (tocLink) tocLink.hidden = false;
  const m = d.multiClauding;
  const summary = document.getElementById("multi-clauding-summary")!;
  summary.textContent = m.overlapEvents > 0
    ? `${m.overlapEvents} overlap event${m.overlapEvents === 1 ? "" : "s"} · ${m.sessionsInvolved}/${m.sessionCount} sessions`
    : `${m.sessionCount} sessions, no overlaps`;
  const stats = document.getElementById("multi-clauding-stats")!;
  const dateRange = (() => {
    const wc = d.wallClock;
    if (!wc.startTimestamp || !wc.endTimestamp) return null;
    const fmtDate = (s: string) => s.slice(0, 10);
    return fmtDate(wc.startTimestamp) + " → " + fmtDate(wc.endTimestamp);
  })();
  type Cell = { label: string; value: string; sub?: string; warn?: boolean };
  const cells: Cell[] = [
    { label: "Sessions", value: String(m.sessionCount) },
    {
      label: "Date range",
      value: dateRange ?? "—",
      sub: d.wallClock.totalSpanMs > 0 ? fmtDuration(d.wallClock.totalSpanMs) + " span" : "",
    },
    { label: "Overlap events", value: String(m.overlapEvents), warn: m.overlapEvents > 0 },
    { label: "Sessions involved", value: String(m.sessionsInvolved) },
    {
      label: "Messages in overlap",
      value: fmt(m.messagesInOverlap),
      sub: m.totalMessages > 0 ? m.overlapPct.toFixed(1) + "% of total" : "",
    },
    { label: "Total messages", value: fmt(m.totalMessages) },
  ];
  stats.innerHTML = cells
    .map(
      (c) =>
        '<div class="stat"><div class="stat-label">' + c.label + "</div>" +
        '<div class="stat-value' + (c.warn ? " warn" : "") + '">' + c.value + "</div>" +
        (c.sub ? '<div class="stat-sub">' + c.sub + "</div>" : "") + "</div>",
    )
    .join("");
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

type FilePathPair = { file: File; path: string };

function fileListToPairs(files: FileList | null): FilePathPair[] {
  if (!files) return [];
  return Array.from(files).map((f) => ({
    file: f,
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name,
  }));
}

// Walk a File System Access directory handle and produce {file, path} pairs.
// Falls back to FileList path if FSA isn't supported.
async function fsaHandleToPairs(
  dirHandle: FileSystemDirectoryHandle,
): Promise<FilePathPair[]> {
  const out: FilePathPair[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    // The async iterator on FileSystemDirectoryHandle is partially typed in lib.dom; cast.
    const entries = (dir as unknown as {
      entries: () => AsyncIterable<[string, FileSystemHandle]>;
    }).entries();
    for await (const [name, handle] of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({ file, path });
      } else if (handle.kind === "directory") {
        await walk(handle as FileSystemDirectoryHandle, path);
      }
    }
  }
  await walk(dirHandle, "");
  return out;
}

// Try the modern picker first (Chrome / Edge / Opera) — passing id makes it
// remember the user's last-picked directory across sessions, so first use is
// the only one that needs manual navigation.
async function pickFolder(): Promise<FilePathPair[]> {
  const w = window as unknown as {
    showDirectoryPicker?: (opts?: {
      id?: string;
      mode?: "read" | "readwrite";
      startIn?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  };
  if (w.showDirectoryPicker) {
    try {
      const handle = await w.showDirectoryPicker({
        id: "cc-debrief-claude",
        mode: "read",
        startIn: "home",
      });
      return await fsaHandleToPairs(handle);
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name === "AbortError") return [];
      // Fall through to fallback if FSA throws for any other reason.
    }
  }
  // Fallback: trigger the legacy <input webkitdirectory> click and await change.
  return new Promise<FilePathPair[]>((resolve) => {
    const input = document.getElementById("folder-input") as HTMLInputElement;
    const onChange = () => {
      input.removeEventListener("change", onChange);
      resolve(fileListToPairs(input.files));
      input.value = "";
    };
    input.addEventListener("change", onChange);
    input.click();
  });
}

// Build IndexedSources from a list of {file, path} pairs.
// Pulls user-level CLAUDE.md, plugin-cache SKILL.md files, and project CLAUDE.md.
async function buildSourcesFromPairs(
  pairs: FilePathPair[],
  sessionCwd: string | undefined,
): Promise<IndexedSources> {
  const sources: IndexedSources = { skills: [], mcpInstructions: [] };
  if (pairs.length === 0) return sources;

  const skillFiles: FilePathPair[] = [];
  let userMd: FilePathPair | null = null;
  let projectMd: FilePathPair | null = null;
  let settingsJson: FilePathPair | null = null;
  const projectBasename = sessionCwd ? sessionCwd.split(/[\\/]/).pop() : null;

  for (const p of pairs) {
    const name = p.file.name;
    if (name === "SKILL.md") skillFiles.push(p);
    else if (name === "CLAUDE.md") {
      if (projectBasename && p.path.toLowerCase().includes(projectBasename.toLowerCase())) {
        projectMd = p;
      } else if (!userMd) {
        userMd = p;
      }
    } else if (name === "settings.json" && p.path.includes(".claude")) {
      settingsJson = p;
    }
  }

  if (userMd) {
    sources.claudeMdUser = {
      path: userMd.path,
      tokens: tokenCount(await userMd.file.text()),
    };
  }
  if (projectMd) {
    sources.claudeMdProject = {
      path: projectMd.path,
      tokens: tokenCount(await projectMd.file.text()),
    };
  }

  let enabledPluginPrefixes: string[] = [];
  if (settingsJson) {
    try {
      const cfg = JSON.parse(await settingsJson.file.text()) as {
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

  for (const p of skillFiles) {
    const isUserSkill = /[\\/]\.?claude[\\/]skills[\\/]/.test(p.path) || /^skills[\\/]/.test(p.path);
    const isEnabledPlugin = enabledPluginPrefixes.some((pref) => p.path.includes(pref));
    if (!isUserSkill && !isEnabledPlugin && enabledPluginPrefixes.length > 0) continue;
    const text = await p.file.text();
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let name = p.path;
    let description = "";
    if (fm) {
      const stripQ = (s: string) => s.trim().replace(/^["']|["']$/g, "");
      const nm = fm[1].match(/^name:\s*(.+)$/m);
      const dm = fm[1].match(/^description:\s*(.+)$/m);
      if (nm) name = stripQ(nm[1]);
      if (dm) description = stripQ(dm[1]);
    }
    const listing = `- ${name}: ${description}\n`;
    sources.skills.push({ name, path: p.path, tokens: tokenCount(listing) });
  }
  sources.skills.sort((a, b) => a.name.localeCompare(b.name));
  return sources;
}

async function processInput(jsonlFile: File, configPairs: FilePathPair[]): Promise<void> {
  setError("");
  const text = await jsonlFile.text();
  const records = parseJsonl(text);
  const sessionCwd = findSessionCwd(records);
  const sources = await buildSourcesFromPairs(configPairs, sessionCwd);
  await renderFromRecords(records, sources, jsonlFile.name);
}

async function processProjectCombined(
  sessions: FilePathPair[],
  projectName: string,
  configPairs: FilePathPair[],
): Promise<void> {
  setError("");
  // Read sessions in chronological order so timestamps stay monotonic.
  const sorted = [...sessions].sort((a, b) => a.file.lastModified - b.file.lastModified);
  const allRecords: unknown[] = [];
  for (const sess of sorted) {
    const text = await sess.file.text();
    const sid = sess.file.name.replace(/\.jsonl$/i, "");
    const parsed = parseJsonl(text);
    // Tag every record with its origin session so analyzers (multi-clauding,
    // future per-session breakdowns) can reconstruct boundaries after merge.
    for (const r of parsed) {
      if (r && typeof r === "object") (r as Record<string, unknown>).__sessionId = sid;
    }
    allRecords.push(...parsed);
  }
  const sessionCwd = findSessionCwd(allRecords);
  const sources = await buildSourcesFromPairs(configPairs, sessionCwd);
  const label = `${projectName} — ${sessions.length} combined sessions`;
  await renderFromRecords(allRecords, sources, label);
}

async function renderFromRecords(
  records: unknown[],
  sources: IndexedSources,
  sourceLabel: string,
): Promise<void> {
  const turns = buildTurns(records, sources);
  if (turns.length === 0) {
    setError("No assistant turns with usage blocks found.");
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
  const toolErrors = analyzeToolErrors(records);
  const languages = analyzeLanguages(records);
  const timeOfDay = analyzeTimeOfDay(records);
  const multiClauding = analyzeMultiClauding(records);

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
    toolErrors,
    languages,
    timeOfDay,
    multiClauding,
  );

  // Make the report container visible BEFORE initCharts. ECharts measures the
  // container at init time; a hidden (display:none) container is 0×0 and the
  // chart renders empty. The toggle handler later resizes when a collapsed
  // <details> is expanded, but cards that start open never trigger toggle.
  document.body.classList.add("has-data");

  document.getElementById("source-path")!.textContent = sourceLabel;
  renderHero(data.hero);
  renderStrip(data.topStrip);
  renderMultiClauding(data);
  renderInsights(data.insights);
  renderRecommendations(data.recommendations);
  renderTopTurns(data.topTurns);
  renderToolErrors(data);
  renderLanguages(data);
  setSummaries(data);
  initCharts(data);
  renderTimeOfDay(data);
  setupInteractivity();

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
  (document.getElementById("file-input") as HTMLInputElement).value = "";
  // Don't reset lastPickedFolder — keeping it lets the user analyze a different
  // .jsonl from the same project without re-picking the .claude folder.
}

function pickJsonlFromList(list: FileList | File[] | null): File | null {
  if (!list) return null;
  const arr = Array.from(list);
  return arr.find((f) => f.name.endsWith(".jsonl")) ?? null;
}

// Cache the most recent folder pick so a JSONL pick afterwards still gets
// CLAUDE.md / skill attribution without re-picking.
let lastPickedFolder: FilePathPair[] = [];

function init(): void {
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const folderBtn = document.getElementById("folder-btn") as HTMLButtonElement;
  const dropArea = document.getElementById("drop-area")!;
  const resetBtn = document.getElementById("reset-btn")!;

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (f) await processInput(f, lastPickedFolder).catch((e) => setError(String(e?.message ?? e)));
    fileInput.value = "";
  });

  folderBtn.addEventListener("click", async () => {
    setError("");
    hideSessionPicker();
    let pairs: FilePathPair[];
    try {
      pairs = await pickFolder();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
      return;
    }
    if (pairs.length === 0) return;
    lastPickedFolder = pairs;

    const jsonls = pairs.filter((p) => p.file.name.endsWith(".jsonl"));
    if (jsonls.length === 1) {
      await processInput(jsonls[0].file, pairs).catch((err) => setError(String(err?.message ?? err)));
    } else if (jsonls.length > 1) {
      showSessionPicker(jsonls, pairs);
    } else {
      setError(
        'Folder loaded — CLAUDE.md and skill attribution armed. Now click "Choose JSONL file" to pick a session.',
      );
    }
  });

  resetBtn.addEventListener("click", reset);
  const backBtn = document.getElementById("back-btn");
  if (backBtn) backBtn.addEventListener("click", reset);

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
    const pairs = files.length > 1 ? fileListToPairs(files) : [];
    if (pairs.length > 0) lastPickedFolder = pairs;
    const jsonl = pickJsonlFromList(files);
    if (!jsonl) {
      setError(
        "Drop didn't include a .jsonl file. Use \"Choose .claude/ folder\" for the config folder, then \"Choose JSONL file\" for the session.",
      );
      return;
    }
    await processInput(jsonl, pairs.length > 0 ? pairs : lastPickedFolder).catch((err) =>
      setError(String(err?.message ?? err)),
    );
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (document.body.classList.contains("has-data")) return;
    if ((e.target as HTMLElement)?.closest("#drop-area")) return;
    e.preventDefault();
    const files = (e as DragEvent).dataTransfer?.files;
    const jsonl = pickJsonlFromList(files ?? null);
    if (jsonl) {
      processInput(jsonl, lastPickedFolder).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    }
  });
}

function pickJsonlFromPairs(pairs: FilePathPair[]): File | null {
  return pairs.find((p) => p.file.name.endsWith(".jsonl"))?.file ?? null;
}

function hideSessionPicker(): void {
  const el = document.getElementById("session-picker")!;
  el.hidden = true;
  document.getElementById("session-list")!.innerHTML = "";
}

function getProjectSlug(path: string): string {
  const parts = path.split(/[\\/]/);
  const i = parts.indexOf("projects");
  if (i >= 0 && i + 1 < parts.length) return parts[i + 1];
  return "(loose sessions)";
}

function fmtSize(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.round(diff / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  if (d < 30) return d + "d ago";
  return fmtDate(ms);
}

function showSessionPicker(jsonls: FilePathPair[], allPairs: FilePathPair[]): void {
  // Group sessions by project slug. Each session pair maps to its project.
  type Group = { project: string; sessions: FilePathPair[]; latestMs: number; totalBytes: number };
  const groups = new Map<string, Group>();
  for (const p of jsonls) {
    const project = getProjectSlug(p.path);
    let g = groups.get(project);
    if (!g) {
      g = { project, sessions: [], latestMs: 0, totalBytes: 0 };
      groups.set(project, g);
    }
    g.sessions.push(p);
    if (p.file.lastModified > g.latestMs) g.latestMs = p.file.lastModified;
    g.totalBytes += p.file.size;
  }
  // Sort each group's sessions by recency, and groups by their latest session.
  for (const g of groups.values()) g.sessions.sort((a, b) => b.file.lastModified - a.file.lastModified);
  const sortedGroups = [...groups.values()].sort((a, b) => b.latestMs - a.latestMs);

  const ol = document.getElementById("session-list")!;
  // If there's only one project, render a flat list (same as before).
  // Otherwise, render a grouped list with expand-on-click.
  if (sortedGroups.length === 1) {
    renderFlatList(ol, sortedGroups[0].sessions, allPairs);
  } else {
    renderGroupedList(ol, sortedGroups, allPairs);
  }

  const summary = document.querySelector("#session-picker h3")!;
  summary.textContent = `${jsonls.length} session${jsonls.length === 1 ? "" : "s"} across ${sortedGroups.length} project${sortedGroups.length === 1 ? "" : "s"} — pick one`;
  document.getElementById("session-picker")!.hidden = false;
}

function renderFlatList(
  ol: HTMLElement,
  sessions: FilePathPair[],
  allPairs: FilePathPair[],
): void {
  ol.innerHTML = sessions
    .map((p, i) => {
      const sessionId = p.file.name.replace(/\.jsonl$/, "").slice(0, 12);
      return (
        '<li class="row" data-i="' + i + '">' +
        '<span class="sess-name">' + escapeHtml(sessionId) + '</span>' +
        '<span class="sess-meta">' + fmtSize(p.file.size) + " · " + fmtAgo(p.file.lastModified) + "</span>" +
        "</li>"
      );
    })
    .join("");
  ol.querySelectorAll<HTMLElement>("li.row").forEach((li) => {
    li.addEventListener("click", async () => {
      const i = Number(li.getAttribute("data-i"));
      hideSessionPicker();
      await processInput(sessions[i].file, allPairs).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    });
  });
}

type Group = { project: string; sessions: FilePathPair[]; latestMs: number; totalBytes: number };

function renderGroupedList(
  ol: HTMLElement,
  groups: Group[],
  allPairs: FilePathPair[],
): void {
  ol.innerHTML = groups
    .map((g, gi) => {
      const sessionRows = g.sessions
        .map((p, si) => {
          const sessionId = p.file.name.replace(/\.jsonl$/, "").slice(0, 12);
          return (
            '<li class="row" data-g="' + gi + '" data-s="' + si + '">' +
            '<span class="sess-name">' + escapeHtml(sessionId) + '</span>' +
            '<span class="sess-meta">' + fmtSize(p.file.size) + " · " + fmtAgo(p.file.lastModified) + "</span>" +
            "</li>"
          );
        })
        .join("");
      const multi = g.sessions.length > 1;
      const expandTitle = multi ? `show all ${g.sessions.length} sessions` : "single session";
      const allTitle = multi
        ? `combine all ${g.sessions.length} sessions into one report`
        : "";
      return (
        '<li class="proj-group" data-g="' + gi + '">' +
        '<div class="proj-header" data-g="' + gi + '" title="Click to load most recent session">' +
        '<span class="proj-name">' + escapeHtml(g.project) + '</span>' +
        '<span class="proj-meta">' +
        g.sessions.length + " session" + (multi ? "s" : "") +
        " · " + fmtSize(g.totalBytes) +
        " · last " + fmtAgo(g.latestMs) +
        '</span>' +
        (multi
          ? '<button type="button" class="proj-loadall" data-g="' + gi + '" title="' + allTitle + '" aria-label="' + allTitle + '">all</button>'
          : "") +
        '<button type="button" class="proj-toggle" data-g="' + gi + '" title="' + expandTitle + '" aria-label="' + expandTitle + '">' +
        (multi ? "▸" : "") +
        '</button>' +
        '</div>' +
        '<ul class="proj-sessions" hidden>' + sessionRows + '</ul>' +
        '</li>'
      );
    })
    .join("");

  // Click anywhere on the header (except the action buttons) → load that
  // project's most recent session immediately.
  ol.querySelectorAll<HTMLElement>(".proj-header").forEach((h) => {
    h.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".proj-toggle") || t.closest(".proj-loadall")) return;
      const gi = Number(h.getAttribute("data-g"));
      const mostRecent = groups[gi].sessions[0];
      hideSessionPicker();
      await processInput(mostRecent.file, allPairs).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    });
  });
  // "all" button → combine all of the project's sessions into one report.
  ol.querySelectorAll<HTMLElement>(".proj-loadall").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const gi = Number(btn.getAttribute("data-g"));
      const g = groups[gi];
      hideSessionPicker();
      await processProjectCombined(g.sessions, g.project, allPairs).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    });
  });
  // Chevron → toggle expand to see all sessions for that project.
  ol.querySelectorAll<HTMLElement>(".proj-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const li = btn.closest<HTMLElement>(".proj-group")!;
      const sublist = li.querySelector<HTMLElement>(".proj-sessions")!;
      if (sublist.children.length <= 1) return;
      const open = !sublist.hidden;
      sublist.hidden = open;
      li.classList.toggle("expanded", !open);
    });
  });
  // Click a session row inside an expanded project → load it.
  ol.querySelectorAll<HTMLElement>("li.row").forEach((li) => {
    li.addEventListener("click", async (e) => {
      e.stopPropagation();
      const gi = Number(li.getAttribute("data-g"));
      const si = Number(li.getAttribute("data-s"));
      const chosen = groups[gi].sessions[si];
      hideSessionPicker();
      await processInput(chosen.file, allPairs).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    });
  });
}

init();
