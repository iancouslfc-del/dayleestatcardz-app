// =====================================================================
//  DayleeStatCardz — data check (run by hand from GitHub Actions)
//  Shows which competitions PitchAPI has, every game it holds for one team
//  this season, and one player's numbers game by game — so app figures can
//  be compared with other sites. Writes out-diag/report.txt.
//  Env: PITCHAPI_KEY, DIAG_TEAM (e.g. "Celta"), DIAG_PLAYER (e.g. "Moriba")
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "out-diag");
const TEAM = (process.env.DIAG_TEAM || "").trim();
const PLAYER = (process.env.DIAG_PLAYER || "").trim();
const lines = [];
const say = (...a) => { const s = a.join(" "); lines.push(s); console.log(s); };

const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; },
};
localStorage.setItem("dsc:keys", JSON.stringify({ pitch: process.env.PITCHAPI_KEY, fd: "" }));
let fetchFn = fetch;
if (process.env.TEST_PROXY) {
  fetchFn = async (url, opts = {}) => {
    const h = opts.headers || {};
    const r = await fetch(process.env.TEST_PROXY + encodeURIComponent(url), { headers: { "x-key": h["X-API-KEY"] || "" } });
    const j = await r.json();
    return { status: j.status, text: async () => j.body || "", headers: { get: () => null } };
  };
}
const noopEl = { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, set innerHTML(_) {}, get innerHTML() { return ""; } };
const ctx = { console, setTimeout, clearTimeout, fetch: fetchFn, URL, URLSearchParams, localStorage, CSS: { escape: (s) => s }, location: { hash: "" },
  document: { addEventListener() {}, querySelector: () => noopEl, querySelectorAll: () => [], fonts: [] }, addEventListener() {}, scrollTo() {} };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "www", "engine.js"), "utf8"), ctx, { filename: "engine.js" });
const G = (e) => vm.runInContext(e, ctx);
const call = G("window.Engine.call");
async function pitch(p) {
  const r = await fetchFn("https://api.pitchapi.dev" + p, { headers: { "X-API-KEY": process.env.PITCHAPI_KEY, Accept: "application/json" } });
  const body = JSON.parse(await r.text() || "null");
  if (r.status !== 200 || body?.error) throw new Error(`HTTP ${r.status} ${body?.error?.message || ""}`.trim());
  return body?.data;
}

const fmt = (iso) => String(iso || "").slice(0, 10);
const nm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// 1. every competition PitchAPI offers
const lg = (await pitch("/v1/leagues"))?.leagues || [];
say(`== PitchAPI competitions (${lg.length}) ==`);
for (const l of lg) say(`${l.id}  ${l.name} [${l.country_code || "-"}]  seasons: ${(l.seasons || []).slice(-3).join(", ")}`);

const comps = (await call("competitions")).competitions;
say(`\n== App competitions ==`);
for (const c of comps) say(`${c.code.padEnd(4)} -> ${c.leagueName || "NOT FOUND"} (${c.leagueId || "-"}) current season ${c.season || "?"}`);

if (TEAM) {
  // 2. every game this team has in ANY PitchAPI competition (latest season of each)
  say(`\n== Every finished game for "${TEAM}" (latest season of each competition) ==`);
  const games = []; const ids = new Set();
  let i = 0;
  const work = async () => {
    while (i < lg.length) {
      const l = lg[i++];
      const seasons = [...(l.seasons || [])].sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0) || String(b).localeCompare(String(a)));
      const season = seasons[0];
      try {
        const q = "status=played" + (season ? "&season=" + encodeURIComponent(season).replace(/%2F/gi, "/") : "");
        const d = await pitch(`/v1/leagues/${l.id}/matches?${q}`);
        for (const m of d?.matches || []) {
          const h = m.home_team, a = m.away_team;
          if (![h, a].some((t) => t && nm(t.name).includes(nm(TEAM)))) continue;
          const me = nm(h?.name).includes(nm(TEAM)) ? h : a;
          ids.add(me.id);
          games.push({ id: m.id, league: l.name, season, time: m.time_utc || m.date, status: m.status, home: h?.name, away: a?.name, score: `${m.score_home ?? "?"}-${m.score_away ?? "?"}`, teamId: me.id });
        }
      } catch (e) { say(`  (${l.name}: ${e.message})`); }
    }
  };
  await Promise.all([work(), work(), work()]);
  games.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  say(`team ids seen: ${[...ids].join(", ")}`);
  for (const g of games) say(`${fmt(g.time)}  ${g.id}  ${g.league} ${g.season}  ${g.home} ${g.score} ${g.away}  [${g.status}]`);

  // 3. one player's numbers in each of those games
  if (PLAYER) {
    say(`\n== "${PLAYER}" game by game (newest first) ==`);
    say(`date        competition            min  fouled fouls shots sot tackles  zero-filled`);
    for (const g of games.slice(0, 30)) {
      if (String(g.status).toLowerCase() !== "finished") continue;
      try {
        const pd = await call("players?id=" + g.id);
        const p = pd.players.find((x) => nm(x.n).includes(nm(PLAYER)));
        if (!p) { say(`${fmt(g.time)}  ${g.league.slice(0, 22).padEnd(22)} not in this game's player list${pd.flags.length ? " · " + pd.flags.join("; ") : ""}`); continue; }
        const s = p.s; const v = (k) => String(s[k] ?? "–").padStart(5);
        say(`${fmt(g.time)}  ${g.league.slice(0, 22).padEnd(22)} ${String(s.min ?? "–").padStart(3)} ${v("fouled")} ${v("fouls")} ${v("shots")} ${v("sot")} ${v("tackles")}   ${(p.zf || []).join(",")}`);
      } catch (e) { say(`${fmt(g.time)}  ${g.league}: ERROR ${e.message}`); }
    }
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "report.txt"), lines.join("\n") + "\n");
