/**
 * The page. One string, no build step, no framework, no dependencies.
 *
 * Inlined rather than served from disk so there is no asset path to resolve, nothing
 * to copy into `dist`, and no way for the built and source versions to disagree. It
 * is a few hundred lines of plain HTML and vanilla JavaScript because that is all a
 * read-only view of a table needs, and because a bundler here would be the first
 * dependency in this project that earns nothing.
 */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jev screener</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #fff; --ink: #1c1b1a; --muted: #6b6864;
    --line: #e4e1dc; --accent: #1f6feb; --warn: #9a3412; --ok: #166534;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16151a; --panel: #1d1c22; --ink: #e9e7e4; --muted: #9a958e;
      --line: #2e2c34; --accent: #6da8ff; --warn: #f59e7a; --ok: #6ee7a8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header { padding: 20px 16px 8px; max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 16px 48px; }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
  input, select, button {
    font: inherit; color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 7px; padding: 6px 9px;
  }
  input { min-width: 180px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); font-size: 12.5px; margin-bottom: 10px; }
  .stats b { color: var(--ink); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); cursor: pointer; user-select: none; font-weight: 600; }
  th:hover { color: var(--ink); }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  tbody tr:last-child td { border-bottom: 0; }
  .num { font-variant-numeric: tabular-nums; }
  .tag { font-size: 11.5px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--muted) 16%, transparent); }
  .tag.warn { background: color-mix(in srgb, var(--warn) 22%, transparent); color: var(--warn); }
  .tag.ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .bars { display: flex; gap: 2px; align-items: flex-end; height: 34px; margin: 6px 0 14px; }
  .bars i { flex: 1; background: var(--accent); opacity: .5; border-radius: 1px 1px 0 0; min-height: 1px; }
  dialog {
    border: 1px solid var(--line); border-radius: 11px; background: var(--panel); color: var(--ink);
    max-width: 860px; width: 92vw; padding: 0;
  }
  dialog::backdrop { background: rgba(0,0,0,.42); }
  .dhead { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  .dbody { padding: 14px 16px; max-height: 68vh; overflow: auto; }
  .kv { display: grid; grid-template-columns: 230px 1fr; gap: 3px 14px; font-size: 13px; }
  .kv div:nth-child(odd) { color: var(--muted); }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 16px 0 6px; }
  .note { color: var(--muted); font-size: 12.5px; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
  .err { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>jev screener</h1>
  <div class="sub" id="stamp">loading…</div>
</header>

<div class="wrap">
  <div class="stats" id="stats"></div>
  <div class="bars" id="dist" title="attractiveness distribution"></div>

  <div class="bar">
    <input id="q" placeholder="filter by ticker or sector" autocomplete="off">
    <select id="sector"><option value="">every sector</option></select>
    <select id="evidence">
      <option value="">any evidence</option>
      <option value="sufficient">sufficient only</option>
      <option value="thin">thin only</option>
    </select>
    <button id="coverage">coverage</button>
    <button id="grade">scorecard</button>
  </div>

  <table>
    <thead><tr>
      <th data-k="rank">#</th><th data-k="label">ticker</th><th data-k="attractiveness">score</th>
      <th data-k="sector">sector</th><th data-k="verdict">verdict</th><th data-k="durability">durability</th>
      <th data-k="accounting">accounting</th><th data-k="candor">candor</th>
      <th data-k="horizon">settles</th><th data-k="evidence">evidence</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>

  <div class="note">
    Candidates for human review. Not a recommendation to buy or sell anything. Read-only:
    this page cannot start a screen — that is a CLI job. Numbers come from the most recent
    persisted run.
  </div>
</div>

<dialog id="detail"><div class="dhead"><b id="dtitle"></b><button onclick="detail.close()">close</button></div><div class="dbody" id="dbody"></div></dialog>

<script>
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let PICKS = [], sortKey = "rank", sortDir = 1;

const HORIZON = ["within a quarter", "1-2 quarters", "2-4 quarters", "1-2 years", "3+ years"];
const band = (n) => typeof n === "number" ? (HORIZON[Math.round(n)] ?? fmt(n)) : "—";

async function load() {
  const res = await fetch("/api/run");
  if (!res.ok) { $("stamp").innerHTML = '<span class="err">' + esc((await res.json()).error) + "</span>"; return; }
  const run = await res.json();

  $("stamp").textContent =
    run.asOf + " · question set " + run.questionSetVersion + " · run " + run.runId.slice(0, 8) +
    (run.contaminated ? " · CONTAMINATED" : "");
  $("stats").innerHTML =
    "<span><b>" + run.counts.included + "</b> included</span>" +
    "<span><b>" + run.counts.judged + "</b> judged</span>" +
    "<span><b>" + run.counts.eligible + "</b> eligible</span>" +
    "<span><b>" + run.counts.considered + "</b> filers</span>";

  PICKS = run.picks.map((p, i) => ({
    rank: i + 1, label: p.ticker, cik: p.cik, sector: p.sector,
    attractiveness: p.attractiveness?.score, verdict: p.verdict?.choice,
    confidence: p.verdict?.confidence, durability: p.durability?.score,
    accounting: p.accountingQuality?.choice, candor: p.managementCandor?.choice,
    risk: p.dominantRisk?.choice, evidence: p.sufficiency?.choice,
    horizon: p.horizonBand?.score, driver: p.horizonDriver?.choice,
  }));

  const sectors = [...new Set(PICKS.map((p) => p.sector))].sort();
  $("sector").innerHTML = '<option value="">every sector</option>' +
    sectors.map((s) => '<option>' + esc(s) + "</option>").join("");

  drawDistribution();
  render();
}

function drawDistribution() {
  const buckets = new Array(20).fill(0);
  for (const p of PICKS) {
    if (typeof p.attractiveness !== "number") continue;
    buckets[Math.min(19, Math.max(0, Math.floor(p.attractiveness / 4 * 20)))]++;
  }
  const peak = Math.max(1, ...buckets);
  $("dist").innerHTML = buckets.map((n) => '<i style="height:' + (n / peak * 100) + '%"></i>').join("");
}

function visible() {
  const q = $("q").value.trim().toLowerCase();
  const sector = $("sector").value, evidence = $("evidence").value;
  return PICKS.filter((p) =>
    (!q || p.label.toLowerCase().includes(q) || p.sector.toLowerCase().includes(q)) &&
    (!sector || p.sector === sector) &&
    (!evidence || p.evidence === evidence));
}

function render() {
  const rows = visible().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (typeof x === "number" && typeof y === "number") return (x - y) * sortDir;
    return String(x).localeCompare(String(y)) * sortDir;
  });

  $("rows").innerHTML = rows.map((p) =>
    "<tr data-t='" + esc(p.label) + "'>" +
    '<td class="num">' + p.rank + "</td>" +
    "<td><b>" + esc(p.label) + "</b></td>" +
    '<td class="num">' + fmt(p.attractiveness) + "</td>" +
    "<td>" + esc(p.sector) + "</td>" +
    '<td><span class="tag ' + (p.verdict === "include" ? "ok" : "") + '">' + esc(p.verdict) +
      " " + Math.round((p.confidence ?? 0) * 100) + "%</span></td>" +
    '<td class="num">' + fmt(p.durability) + "</td>" +
    '<td><span class="tag ' + (p.accounting === "clean" ? "" : "warn") + '">' + esc(p.accounting) + "</span></td>" +
    "<td>" + esc(p.candor) + "</td>" +
    "<td>" + esc(band(p.horizon)) + " <span class='tag'>" + esc(p.driver) + "</span></td>" +
    '<td><span class="tag ' + (p.evidence === "sufficient" ? "ok" : "warn") + '">' + esc(p.evidence) + "</span></td>" +
    "</tr>").join("") ||
    '<tr><td colspan="10" style="color:var(--muted)">nothing matches that filter</td></tr>';

  for (const tr of $("rows").querySelectorAll("tr[data-t]")) {
    tr.onclick = () => explain(tr.dataset.t);
  }
}

async function explain(ticker) {
  $("dtitle").textContent = ticker;
  $("dbody").textContent = "loading…";
  detail.showModal();

  const res = await fetch("/api/explain?ticker=" + encodeURIComponent(ticker));
  const d = await res.json();
  if (!res.ok) { $("dbody").innerHTML = '<span class="err">' + esc(d.error) + "</span>"; return; }

  const metrics = Object.entries(d.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const obs = (d.observations ?? []).slice(-40).reverse();

  $("dbody").innerHTML =
    '<div class="kv"><div>filer</div><div>' + esc(d.entity ?? "—") + "</div>" +
    "<div>sector</div><div>" + esc(d.sector) + "</div>" +
    "<div>eligible</div><div>" + (d.eligible ? "yes" : "no — " + esc((d.missing ?? []).join("; "))) + "</div></div>" +
    "<h3>computed metrics</h3><div class='kv'>" +
    metrics.map(([k, v]) => "<div>" + esc(k) + "</div><div class='num'>" + fmt(v.value, 4) +
      " <span class='tag'>knownAt " + esc(v.knownAt) + "</span></div>").join("") + "</div>" +
    "<h3>provenance — newest first" + (d.observationsOmitted ? " (" + d.observationsOmitted + " older omitted)" : "") + "</h3>" +
    "<div class='kv'>" + obs.map((o) =>
      "<div>" + esc(o.metric) + " @ " + esc(o.validAt) + "</div><div class='num'>" + fmt(o.value, 2) +
      " <span class='tag'>knownAt " + esc(o.knownAt) + "</span> <span class='tag'>" + esc(o.tag ?? o.source) + "</span></div>"
    ).join("") + "</div>";
}

async function panel(url, title) {
  $("dtitle").textContent = title;
  $("dbody").textContent = "loading…";
  detail.showModal();
  const d = await (await fetch(url)).json();
  $("dbody").innerHTML = "<pre style='white-space:pre-wrap;font:12px ui-monospace,monospace'>" +
    esc(JSON.stringify(d, null, 2)) + "</pre>";
}

$("q").oninput = render;
$("sector").onchange = render;
$("evidence").onchange = render;
$("coverage").onclick = () => panel("/api/coverage", "coverage");
$("grade").onclick = () => panel("/api/grade", "scorecard");
for (const th of document.querySelectorAll("th[data-k]")) {
  th.onclick = () => {
    const k = th.dataset.k;
    sortDir = sortKey === k ? -sortDir : (k === "rank" || k === "label" || k === "sector" ? 1 : -1);
    sortKey = k;
    render();
  };
}
load();
</script>
</body>
</html>`;
