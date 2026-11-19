// =====================================================================
//  DayleeStatCardz — Daily Brief generator
//  Runs on GitHub's free machines every morning (see
//  .github/workflows/daily-brief.yml). It loads the app's own engine
//  (www/engine.js, app.js, players.js) so every number is calculated
//  exactly as the app does it, scans every fixture in the next
//  BRIEF_HOURS hours across all leagues, and writes out/brief.json.
//
//  Env:  PITCHAPI_KEY (required)  FOOTBALL_DATA_KEY (optional)
//        BRIEF_HOURS (default 36) BRIEF_MAX_FIXTURES (default 80)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WWW = path.join(ROOT, "www");
const CACHE_DIR = path.join(ROOT, ".brief-cache");
const CACHE_FILE = path.join(CACHE_DIR, "store.json");
const OUT_DIR = path.join(ROOT, "out");
const HOURS = Number(process.env.BRIEF_HOURS || 36);
const MAX_FIX = Number(process.env.BRIEF_MAX_FIXTURES || 80);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

if (!process.env.PITCHAPI_KEY) { console.error("PITCHAPI_KEY is not set. Add it in GitHub → Settings → Secrets and variables → Actions."); process.exit(1); }

// ---------- phone-storage stand-in, kept between runs (finished matches never change) ----------
let store = {};
try { store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); log(`cache: ${Object.keys(store).length} entries`); } catch { log("cache: empty"); }
for (const k of Object.keys(store)) if (k.startsWith("dsc:c:")) delete store[k]; // league lists & fixtures always fresh
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
};
localStorage.setItem("dsc:keys", JSON.stringify({ pitch: process.env.PITCHAPI_KEY, fd: process.env.FOOTBALL_DATA_KEY || "" }));

// Optional test hook: route provider calls through a local mock.
let fetchFn = fetch;
if (process.env.TEST_PROXY) {
  fetchFn = async (url, opts = {}) => {
    const h = opts.headers || {};
    const r = await fetch(process.env.TEST_PROXY + encodeURIComponent(url), { headers: { "x-key": h["X-API-KEY"] || h["X-Auth-Token"] || "" } });
    const j = await r.json();
    return { status: j.status, text: async () => j.body || "", headers: { get: () => null } };
  };
}

// ---------- load the app's own code in a sandbox ----------
const noopEl = { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, set innerHTML(_) {}, get innerHTML() { return ""; } };
const ctx = {
  console, setTimeout, clearTimeout, fetch: fetchFn, URL, URLSearchParams, localStorage,
  CSS: { escape: (s) => s }, location: { hash: "" },
  document: { addEventListener() {}, querySelector: () => noopEl, querySelectorAll: () => [], fonts: [] },
  addEventListener() {}, scrollTo() {},
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["engine.js", "app.js", "players.js"]) {
  let src = fs.readFileSync(path.join(WWW, f), "utf8");
  // the phone keeps ~400 finished matches; the brief keeps far more between runs
  src = src.replace("idx.length > 400", "idx.length > 6000").replace("idx.length > 350", "idx.length > 6000");
  vm.runInContext(src, ctx, { filename: f });
}
const G = (expr) => vm.runInContext(expr, ctx);
const api = G("api"), loadDetails = G("loadDetails"), buildTips = G("buildTips"), sideTotals = G("sideTotals");
const plInit = G("plInit"), plLoad = G("plLoad"), plLineups = G("plLineups"), plIds = G("plIds"), buildPlayerProps = G("buildPlayerProps");
const S = G("S"), PL = G("PL"), PROP_DEFS = G("PROP_DEFS"), COMPS = G("window.Engine.COMPETITIONS");
plInit();

const r2 = (x) => Math.round(x * 10) / 10;
const slimTip = (t) => ({ label: t.label, cat: t.cat, period: t.period, dir: t.dir, line: t.line, pooled: r2(t.pooled), hits: t.hits, n: t.n, score: t.score, small: !!t.small, strong: !!t.strong,
  legs: t.legs.map((l) => ({ label: l.label, hits: l.res.hits, n: l.res.n, pct: r2(l.res.pct) })) });
const slimProp = (p) => ({ ...p, pct: r2(p.pct), rows: p.rows.map((r) => ({ v: r.v, hit: r.hit, min: r.min, zf: r.zf, home: r.home, date: r.date, opp: { name: r.opp.name, img: r.opp.img } })) });

// Streaks: for every player & stat, how many games in a row (newest first) each line was hit — all games this season.
function streaksFor(A, fx) {
  const out = [];
  for (const p of buildPlayerProps(A, "all", { chip: "best", all: true })) {
    const def = PROP_DEFS.find((d) => d.stat === p.stat); if (!def) continue;
    const valid = p.rows.filter((r) => r.v !== null);
    const streaks = {};
    for (const line of def.lines) { let k = 0; for (const r of valid) { if (r.v > line) k++; else break; } if (k) streaks[line] = k; }
    const best = Math.max(0, ...Object.values(streaks));
    if (best < 3) continue;
    out.push({ fx, player: p.player, team: p.team, side: p.side, stat: p.stat, streaks, n: valid.length, vals: valid.map((r) => r.v).slice(0, 10) });
  }
  return out;
}

// ---------- 1. fixtures in the window ----------
const brief = { v: 1, generatedAt: new Date().toISOString(), hours: HOURS, leagues: [], fixtures: [], errors: [] };
const until = Date.now() + HOURS * 3600e3;
let fixtures = [];
const compInfo = {};
try { for (const c of (await api("competitions")).competitions) compInfo[c.code] = c; } catch (e) { brief.errors.push("Leagues: " + e.message); }
for (const c of COMPS) {
  try {
    const d = await api(`fixtures?comp=${c.code}`);
    const list = d.fixtures.filter((f) => Date.parse(f.time) <= until && Date.parse(f.time) >= Date.now() - 2 * 3600e3);
    fixtures.push(...list);
    brief.leagues.push({ code: c.code, name: c.name, logo: compInfo[c.code]?.logo || null, fixtures: list.length });
    log(`${c.code}: ${list.length} fixtures`);
  } catch (e) { brief.errors.push(`${c.name}: ${e.message}`); log(`${c.code}: ERROR ${e.message}`); }
}
fixtures.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
if (fixtures.length > MAX_FIX) { brief.errors.push(`Only the first ${MAX_FIX} of ${fixtures.length} fixtures were analysed.`); fixtures = fixtures.slice(0, MAX_FIX); }

// ---------- 2. analyse each fixture ----------
let i = 0;
for (const f of fixtures) {
  i++;
  try {
    const A = await api(`analysis?comp=${f.comp}&match=${f.id}`);
    await loadDetails([...new Set([...A.home.sample, ...A.away.sample].map((m) => m.id))], () => {});
    S.analysis = A;
    const tips = buildTips();
    const small = buildTips(3).filter((t) => t.small && !tips.some((x) => x.key === t.key)).slice(0, 4);
    const totals = {};
    for (const tab of ["goals", "corners", "cards"]) {
      totals[tab] = {};
      for (const per of ["FT", "H1", "H2"]) {
        const h = sideTotals(A.home, tab, per), a = sideTotals(A.away, tab, per);
        totals[tab][per] = { home: { n: h.n, total: h.total, team: h.team, opp: h.opp }, away: { n: a.n, total: a.total, team: a.team, opp: a.opp } };
      }
    }
    await plLineups(f.id);
    await plLoad([...new Set([...plIds(A, "venue"), ...plIds(A, "all")])], () => {});
    const props = buildPlayerProps(A, "venue", { chip: "best" });
    const per = new Map(), topProps = [];
    for (const p of props) { const c = per.get(p.player.id) || 0; if (c >= 2) continue; per.set(p.player.id, c + 1); topProps.push(p); if (topProps.length >= 10) break; }
    const fx = { id: f.id, comp: f.comp };
    brief.fixtures.push({
      id: f.id, comp: f.comp, compName: compInfo[f.comp]?.name || f.comp, time: f.time, round: f.round || null,
      home: { id: f.home.id, name: f.home.name, img: f.home.img }, away: { id: f.away.id, name: f.away.name, img: f.away.img },
      referee: A.fixture.referee || null, nHome: A.home.sample.length, nAway: A.away.sample.length,
      tips: tips.slice(0, 8).map(slimTip), small: small.map(slimTip), totals,
      players: topProps.map(slimProp), streaks: streaksFor(A, fx),
    });
    log(`${i}/${fixtures.length} ${f.home.name} v ${f.away.name}: ${tips.length} tips, ${props.length} player lines`);
  } catch (e) {
    brief.errors.push(`${f.home.name} v ${f.away.name}: ${e.message}`);
    log(`${i}/${fixtures.length} ${f.home.name} v ${f.away.name}: ERROR ${e.message}`);
  }
}

// ---------- 3. write ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "brief.json"), JSON.stringify(brief));
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.writeFileSync(CACHE_FILE, JSON.stringify(store));
const kb = Math.round(fs.statSync(path.join(OUT_DIR, "brief.json")).size / 1024);
log(`done: ${brief.fixtures.length} fixtures, ${brief.errors.length} errors, ${kb} KB`);

// ---------- 4. short summary for the phone notification ----------
const allTips = brief.fixtures.flatMap((f) => f.tips.filter((t) => !t.small).map((t) => ({ f, t }))).sort((a, b) => b.t.score - a.t.score).slice(0, 3);
const PER = { FT: "FT", H1: "1H", H2: "2H" };
const lines = allTips.map(({ f, t }, k) => `${k + 1}. ${f.home.name} v ${f.away.name} — ${t.label} (${PER[t.period]}) ${Math.round(t.pooled)}%`);
const summary = `${brief.fixtures.length} fixtures analysed.` + (lines.length ? `\nTop picks:\n${lines.join("\n")}` : "");
fs.writeFileSync(path.join(OUT_DIR, "summary.txt"), summary);
if (!brief.fixtures.length && brief.errors.length) process.exitCode = 1;
