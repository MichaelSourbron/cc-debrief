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

function showSessionPicker(jsonls: FilePathPair[], allPairs: FilePathPair[]): void {
  const fmtSize = (b: number) => {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  };
  // Sort by recency (largest mtime first); File.lastModified is ms epoch.
  const sorted = [...jsonls].sort((a, b) => b.file.lastModified - a.file.lastModified);
  const ol = document.getElementById("session-list")!;
  ol.innerHTML = sorted
    .map((p, i) => {
      const date = new Date(p.file.lastModified).toISOString().slice(0, 16).replace("T", " ");
      return (
        '<li data-i="' + i + '">' +
        '<span class="sess-name">' + escapeHtml(p.path) + "</span>" +
        '<span class="sess-meta">' + fmtSize(p.file.size) + " · " + date + "</span>" +
        "</li>"
      );
    })
    .join("");
  ol.querySelectorAll<HTMLElement>("li").forEach((li) => {
    li.addEventListener("click", async () => {
      const i = Number(li.getAttribute("data-i"));
      const chosen = sorted[i];
      hideSessionPicker();
      await processInput(chosen.file, allPairs).catch((err) =>
        setError(String(err?.message ?? err)),
      );
    });
  });
  document.getElementById("session-picker")!.hidden = false;
}

init();
