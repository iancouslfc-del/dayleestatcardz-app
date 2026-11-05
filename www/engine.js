/* =====================================================================
   DayleeStatCardz — data engine (runs inside the app on the phone)

   "Data servers" (providers) are connected in the app's Data servers
   screen; keys are stored only on this phone.
     PitchAPI (required)          fixtures, results back to 2021, corners per
                                  half, card + goal timelines
     football-data.org (optional) official half-time scores; cross-checks
                                  PitchAPI results (current season)

   In the Android app every request goes through the native bridge
   (window.NativeHttp), which only talks to the two provider hosts.
   ===================================================================== */
(function () {
"use strict";
// ---------------------------------------------------------------------
//  1. COMPETITIONS — add a new league by adding one line here.
//     pitch.names  = names PitchAPI might use (matched loosely)
//     pitch.cc     = acceptable PitchAPI country codes ([] = any)
//     fd           = football-data.org code (null if not on their free tier)
// ---------------------------------------------------------------------
const COMPETITIONS = [
  { code: "PL",  name: "Premier League",   short: "EPL",   country: "England", pitch: { names: ["Premier League", "English Premier League"], cc: ["ENG", "GB-ENG", "EN", "GB", "GBR", "UK"] }, fd: "PL" },
  { code: "ELC", name: "Championship",     short: "CHAMP", country: "England", pitch: { names: ["Championship", "EFL Championship", "English Championship"], cc: ["ENG", "GB-ENG", "EN", "GB", "GBR", "UK"] }, fd: "ELC" },
  { code: "CL",  name: "Champions League", short: "UCL",   country: "Europe",  pitch: { names: ["Champions League", "UEFA Champions League"], cc: [], exclude: ["afc", "caf", "concacaf", "women", "youth", "ofc", "conference", "europa"] }, fd: "CL" },
  { code: "PD",  name: "La Liga",          short: "LIGA",  country: "Spain",   pitch: { names: ["LaLiga", "La Liga", "Primera Division", "LaLiga EA Sports"], cc: ["ESP", "ES"] }, fd: "PD" },
  { code: "SA",  name: "Serie A",          short: "SERIE A", country: "Italy", pitch: { names: ["Serie A"], cc: ["ITA", "IT"], strictCountry: true }, fd: "SA" },
  { code: "BSA", name: "Brasileirão Série A", short: "BRA", country: "Brazil", pitch: { names: ["Serie A", "Série A", "Brasileirao", "Brasileirão", "Brasileirao Serie A", "Campeonato Brasileiro Serie A"], cc: ["BRA", "BR"], strictCountry: true, exclude: ["serie b", "serie c"] }, fd: "BSA" },
];

const SAMPLE_SIZE = 10;
const MAX_SEASONS_BACK = 4;         // how far back we look to fill a 10-match sample
const FIXTURE_WINDOW_DAYS = 21;     // upcoming fixtures shown
const PITCH_BASE = "https://api.pitchapi.dev";
const FD_BASE = "https://api.football-data.org/v4";

// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
//  2. Small helpers: storage, caching, HTTP via the phone
// ---------------------------------------------------------------------
const LS = {
  get(k) { try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};
const mem = new Map(); // key -> { exp, value(Promise) }

// persist=true also keeps the result on the phone (survives app restarts)
function cached(key, ttlSec, loader, persist) {
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (persist) {
    const p = LS.get("dsc:c:" + key);
    if (p && p.exp > Date.now()) { const v = Promise.resolve(p.v); mem.set(key, { exp: p.exp, value: v }); return v; }
  }
  const exp = Date.now() + ttlSec * 1000;
  const pr = loader().then((v) => {
    if (persist && !LS.set("dsc:c:" + key, { exp, v })) { pruneStore(); LS.set("dsc:c:" + key, { exp, v }); }
    return v;
  }).catch((e) => { mem.delete(key); throw e; });
  mem.set(key, { exp, value: pr });
  return pr;
}
function pruneStore() { for (const k of LS.keys()) if (k.startsWith("dsc:c:")) LS.del(k); }
// Refresh: forget everything that can change (current season, fixtures, leagues).
function refresh() {
  mem.clear();
  for (const k of LS.keys()) if (k.startsWith("dsc:c:") && !k.includes(":old")) LS.del(k);
}

class ApiError extends Error {
  constructor(status, code, message, hint) { super(message); this.status = status; this.code = code; this.hint = hint; }
}

function getKeys() {
  const k = LS.get("dsc:keys") || {};
  return { pitch: (k.pitch || "").trim(), fd: (k.fd || "").trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- HTTP: native bridge in the Android app, fetch() elsewhere ----
let seq = 0;
const waiting = new Map();
window.__nativeHttpDone = function (id, payload) {
  const w = waiting.get(id); if (!w) return;
  waiting.delete(id);
  let r; try { r = JSON.parse(payload); } catch { r = { status: 0, error: "Bad native response" }; }
  w(r);
};
function rawGet(url, headers) {
  if (window.NativeHttp && window.NativeHttp.request) {
    return new Promise((resolve) => {
      const id = "r" + (++seq);
      const timer = setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ status: 0, error: "timeout" }); } }, 45000);
      waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      window.NativeHttp.request(id, url, JSON.stringify(headers || {}));
    });
  }
  return fetch(url, { headers }).then(async (res) => ({ status: res.status, body: await res.text(), retryAfter: res.headers.get("retry-after") }))
    .catch((e) => ({ status: 0, error: String(e) }));
}

async function httpJson(url, headers, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await rawGet(url, { Accept: "application/json", ...headers });
    if (!r.status) throw new ApiError(502, "PROVIDER_UNREACHABLE", `${label} could not be reached.`, "Check your internet connection and tap refresh.");
    if (r.status === 429 && attempt === 0) { await sleep(Math.min(Number(r.retryAfter) || 2, 4) * 1000); continue; }
    let body = null;
    try { body = JSON.parse(r.body); } catch {}
    if (r.status < 200 || r.status >= 300) {
      const pcode = body?.error?.code || body?.errorCode || r.status;
      const msg = body?.error?.message || body?.message || "HTTP " + r.status;
      if (r.status === 401 || r.status === 403) throw new ApiError(r.status, "PROVIDER_AUTH", `${label} rejected the API key (${pcode}).`, `Open Data servers and check your ${label} key.`);
      if (r.status === 404) throw new ApiError(404, String(pcode), `${label}: ${msg}`);
      if (r.status === 429) throw new ApiError(429, "PROVIDER_BUSY", `${label} is limiting requests right now.`, "Wait a minute and tap refresh.");
      throw new ApiError(502, "PROVIDER_ERROR", `${label} error ${r.status}: ${msg}`);
    }
    if (body === null) throw new ApiError(502, "PROVIDER_ERROR", `${label} sent something that isn't data.`);
    return body;
  }
}

async function pitch(path, keys) {
  if (!keys.pitch) throw new ApiError(503, "NO_PITCH_KEY", "PitchAPI isn't connected yet.", "Open Data servers and paste your PitchAPI key.");
  const body = await httpJson(PITCH_BASE + path, { "X-API-KEY": keys.pitch }, "PitchAPI");
  if (body && body.error) throw new ApiError(502, body.error.code || "PROVIDER_ERROR", "PitchAPI: " + (body.error.message || "error"));
  return body?.data;
}

async function fd(path, keys) {
  if (!keys.fd) return null;
  return httpJson(FD_BASE + path, { "X-Auth-Token": keys.fd }, "football-data.org");
}

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const num = (v) => { if (v === null || v === undefined) return null; const m = String(v).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const isInt = (v) => Number.isInteger(v) && v >= 0;

// ---------------------------------------------------------------------
//  3. PitchAPI league resolution
// ---------------------------------------------------------------------
async function pitchLeagues(keys) {
  return cached("pitch:leagues", 6 * 3600, async () => {
    const d = await pitch("/v1/leagues", keys);
    return (d?.leagues || []).map((l) => ({ id: l.id, name: l.name, cc: (l.country_code || "").toUpperCase(), img: l.image_url || null, seasons: l.seasons || [] }));
  }, true);
}

function overrideIds() { return LS.get("dsc:leagueIds") || {}; }

async function resolveCompetitions(keys) {
  const leagues = await pitchLeagues(keys);
  const overrides = overrideIds();
  return COMPETITIONS.map((c) => {
    let chosen = null, how = "";
    if (overrides[c.code]) {
      chosen = leagues.find((l) => l.id === overrides[c.code]) || null;
      how = chosen ? "override" : "override-not-found";
    } else {
      const wanted = c.pitch.names.map(norm);
      const excl = (c.pitch.exclude || []).map(norm);
      const scored = leagues.map((l) => {
        const n = norm(l.name);
        if (excl.some((x) => n.includes(x))) return { l, s: -1 };
        let s = 0;
        if (wanted.includes(n)) s += 3;
        else if (wanted.some((w) => n.includes(w) || w.includes(n))) s += 1;
        if (s === 0) return { l, s: 0 };
        const ccOk = !c.pitch.cc.length || c.pitch.cc.includes(l.cc);
        if (c.pitch.strictCountry && !ccOk) return { l, s: 0 };
        if (c.pitch.cc.length && ccOk) s += 3;
        return { l, s };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) { chosen = scored[0].l; how = "auto"; }
      else if (scored.length) { how = "ambiguous: " + scored.slice(0, 3).map((x) => `${x.l.name} (${x.l.cc}) ${x.l.id}`).join(", "); }
      else how = "not-found";
    }
    return { code: c.code, name: c.name, short: c.short, country: c.country, fd: c.fd, leagueId: chosen?.id || null, leagueName: chosen?.name || null, leagueCC: chosen?.cc || null, logo: chosen?.img || null, seasons: chosen?.seasons || [], resolved: !!chosen, how };
  });
}

async function getComp(code, keys) {
  const comps = await cached("pitch:resolved", 3600, () => resolveCompetitions(keys));
  const c = comps.find((x) => x.code === code);
  if (!c) throw new ApiError(400, "UNKNOWN_COMPETITION", `Unknown competition "${code}".`);
  if (!c.resolved) throw new ApiError(503, "LEAGUE_NOT_MAPPED", `Couldn't match ${c.name} to a PitchAPI league automatically.`, `Open Data servers → Leagues and pick the right league for ${c.name}.`);
  return c;
}

// ---------------------------------------------------------------------
//  4. Matches
// ---------------------------------------------------------------------
function slimTeam(t) { return t ? { id: t.id, name: t.name, img: t.image_url || null } : null; }

function slimMatch(m, comp) {
  return {
    id: m.id, comp,
    time: m.time_utc || (m.date ? m.date + "T12:00:00Z" : null), date: m.date || (m.time_utc || "").slice(0, 10),
    status: m.status, round: m.round_name || null,
    home: slimTeam(m.home_team), away: slimTeam(m.away_team),
    score: isInt(m.score_home) && isInt(m.score_away) ? [m.score_home, m.score_away] : null,
  };
}

async function seasonMatches(comp, season, status, keys) {
  const isCurrent = !season || season === comp.seasons[0];
  const ttl = status === "upcoming" ? 900 : isCurrent ? 900 : 7 * 24 * 3600;
  const q = new URLSearchParams({ status });
  if (season) q.set("season", season);
  return cached(`pitch:lm:${comp.leagueId}:${season || "x"}:${status}:${isCurrent ? "cur" : "old"}`, ttl, async () => {
    const d = await pitch(`/v1/leagues/${comp.leagueId}/matches?${q}`, keys);
    return (d?.matches || []).map((m) => slimMatch(m, comp.code));
  }, true);
}

async function fixtures(code, keys) {
  const comp = await getComp(code, keys);
  const list = await seasonMatches(comp, null, "upcoming", keys);
  const now = Date.now() - 3 * 3600 * 1000;
  const until = Date.now() + FIXTURE_WINDOW_DAYS * 86400000;
  return list.filter((m) => { const t = Date.parse(m.time); return t >= now && t <= until; }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

const finished = (m) => String(m.status || "").toLowerCase() === "finished" && m.score;

async function sampleFor(comp, teamId, side, beforeIso, keys) {
  const before = Date.parse(beforeIso);
  const out = []; const scanned = [];
  const seasons = comp.seasons.length ? comp.seasons.slice(0, MAX_SEASONS_BACK) : [null];
  for (const s of seasons) {
    let list;
    try { list = await seasonMatches(comp, s, "played", keys); }
    catch (e) { if (e.status === 404) continue; throw e; }
    scanned.push(s || "current");
    const mine = list.filter((m) => finished(m) && Date.parse(m.time) < before && (side === "home" ? m.home?.id === teamId : m.away?.id === teamId));
    for (const m of mine) if (!out.find((x) => x.id === m.id)) out.push(m);
    if (out.length >= SAMPLE_SIZE) break;
  }
  out.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return { matches: out.slice(0, SAMPLE_SIZE), seasonsScanned: scanned };
}

// ---------------------------------------------------------------------
//  5. football-data.org cross-check (optional)
// ---------------------------------------------------------------------
const STOP = new Set("fc afc cf sc ac ec se cr ca cd ud rcd sd ssc us as acf fk sk bk club de da do del la le the football futebol futbol calcio fbpa sad and of".split(" "));
const ALIAS = { "man": "manchester", "utd": "united", "spurs": "tottenham", "wolves": "wolverhampton", "nottm": "nottingham", "nott": "nottingham", "inter": "internazionale", "milano": "milan", "atl": "atletico", "brighton": "brighton", "psg": "paris", "qpr": "queens" };
function tokens(name) { return norm(name).split(" ").map((t) => ALIAS[t] || t).filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)); }
function nameSim(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

async function fdMatches(fdCode, keys) {
  if (!fdCode || !keys.fd) return null;
  return cached(`fd:m:${fdCode}`, 900, async () => {
    const d = await fd(`/competitions/${fdCode}/matches`, keys);
    return (d?.matches || []).map((m) => {
      const sc = m.score || {};
      const reg = sc.regularTime && isInt(sc.regularTime.home) ? sc.regularTime : null;
      const ft = reg || sc.fullTime || {};
      const ht = sc.halfTime || {};
      return {
        id: m.id, time: m.utcDate, status: m.status, duration: sc.duration || "REGULAR",
        home: m.homeTeam?.name || m.homeTeam?.shortName, away: m.awayTeam?.name || m.awayTeam?.shortName,
        homeShort: m.homeTeam?.shortName, awayShort: m.awayTeam?.shortName,
        ft: isInt(ft.home) && isInt(ft.away) ? [ft.home, ft.away] : null,
        fullTime: isInt(sc.fullTime?.home) ? [sc.fullTime.home, sc.fullTime.away] : null,
        ht: isInt(ht.home) && isInt(ht.away) ? [ht.home, ht.away] : null,
        referee: (m.referees || []).find((r) => r.type === "REFEREE")?.name || null,
      };
    });
  });
}

function crossCheck(pm, fdList) {
  if (!fdList) return { status: "disabled" };
  const t = Date.parse(pm.time);
  let best = null;
  for (const f of fdList) {
    const dt = Math.abs(Date.parse(f.time) - t);
    if (dt > 36 * 3600 * 1000) continue;
    const hs = Math.max(nameSim(pm.home.name, f.home), nameSim(pm.home.name, f.homeShort || ""));
    const as = Math.max(nameSim(pm.away.name, f.away), nameSim(pm.away.name, f.awayShort || ""));
    const nameOk = (hs >= 0.5 && as >= 0.5 && hs + as >= 1.5) || (Math.max(hs, as) >= 1 && Math.min(hs, as) > 0);
    if (!nameOk) continue;
    const score = hs + as - dt / (36 * 3600 * 1000);
    if (!best || score > best.score) best = { f, score };
  }
  if (!best) {
    const covered = fdList.some((f) => Math.abs(Date.parse(f.time) - t) < 4 * 86400000);
    return { status: covered ? "not_found" : "outside_fd_window" };
  }
  const f = best.f;
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const ftMatch = same(f.ft, pm.score) || same(f.fullTime, pm.score);
  return { status: ftMatch ? "verified" : "score_mismatch", fdId: f.id, fdHome: f.home, fdAway: f.away, ft: f.ft, ht: f.ht, duration: f.duration, referee: f.referee };
}

// ---------------------------------------------------------------------
//  6. Analysis — THE RULE: home side = last 10 HOME, away side = last 10 AWAY
// ---------------------------------------------------------------------
async function analysis(code, matchId, keys) {
  const comp = await getComp(code, keys);
  const raw = await cached(`pitch:match:${matchId}`, 600, () => pitch(`/v1/matches/${matchId}`, keys));
  if (!raw) throw new ApiError(404, "MATCH_NOT_FOUND", "Match not found.");
  const fx = slimMatch(raw, code);
  if (!fx.home || !fx.away || !fx.time) throw new ApiError(502, "BAD_MATCH", "Provider returned an incomplete fixture.");
  // Only matches played BEFORE this fixture's kick-off are eligible.
  const [h, a] = await Promise.all([
    sampleFor(comp, fx.home.id, "home", fx.time, keys),
    sampleFor(comp, fx.away.id, "away", fx.time, keys),
  ]);
  let fdList = null, fdError = null;
  try { fdList = await fdMatches(comp.fd, keys); } catch (e) { fdError = e.message; }
  const tag = (m) => ({ ...m, fd: fdError ? { status: "error", error: fdError } : crossCheck(m, fdList) });
  return {
    generatedAt: new Date().toISOString(),
    rule: `Home side: last ${SAMPLE_SIZE} completed HOME matches in ${comp.name}. Away side: last ${SAMPLE_SIZE} completed AWAY matches in ${comp.name}. Only matches before kick-off.`,
    competition: { code: comp.code, name: comp.name, logo: comp.logo },
    fixture: { ...fx, referee: raw.referee || null, stadium: raw.stadium || null },
    home: { team: fx.home, side: "home", seasonsScanned: h.seasonsScanned, sample: h.matches.map(tag) },
    away: { team: fx.away, side: "away", seasonsScanned: a.seasonsScanned, sample: a.matches.map(tag) },
    fdEnabled: !!keys.fd, fdError,
  };
}

// ---------------------------------------------------------------------
//  7. One match: corners (stats per period), cards + goals (events)
// ---------------------------------------------------------------------
function periodKey(p) { const n = norm(p).replace(/ /g, ""); return n === "all" ? "FT" : n === "firsthalf" ? "H1" : n === "secondhalf" ? "H2" : null; }

function findItem(items, test) {
  const exact = items.find((i) => test.exact.test(i.key || "") || test.exact.test(i.title || ""));
  return exact || items.find((i) => test.loose.test(i.key || "") || test.loose.test(i.title || ""));
}
const T_CORNERS = { exact: /^corners?$/i, loose: /corner/i };
const T_YELLOW = { exact: /^yellow[ _]?cards?$/i, loose: /yellow/i };
const T_RED = { exact: /^red[ _]?cards?$/i, loose: /red[ _]?card/i };

function parseStats(stats) {
  const out = { corners: { FT: null, H1: null, H2: null }, cards: { FT: null, H1: null, H2: null }, periodsSeen: [] };
  for (const p of stats?.periods || []) {
    const k = periodKey(p.period); if (!k) continue;
    out.periodsSeen.push(p.period);
    const items = (p.groups || []).flatMap((g) => g.items || []);
    const c = findItem(items, T_CORNERS);
    if (c) { const h = num(c.home), a = num(c.away); if (isInt(h) && isInt(a)) out.corners[k] = [h, a]; }
    const y = findItem(items, T_YELLOW), r = findItem(items, T_RED);
    if (y) {
      const yh = num(y.home), ya = num(y.away);
      const rh = r ? num(r.home) : 0, ra = r ? num(r.away) : 0;
      if (isInt(yh) && isInt(ya) && isInt(rh) && isInt(ra)) out.cards[k] = { y: [yh, ya], r: [rh, ra], redItemMissing: !r };
    }
  }
  return out;
}

function evType(e) { return norm(e.event_type || e.type).replace(/ /g, ""); }

function parseEvents(events, homeId, awayId, ft) {
  const list = Array.isArray(events) ? events : [];
  const res = { ok: false, ht: null, rt: null, et: false, cards: null, reason: "" };
  if (!list.length) { res.reason = "no events published"; return res; }
  const side = (e) => (e.team_id === homeId ? 0 : e.team_id === awayId ? 1 : null);
  const minute = (e) => Number(e.minute) || 0;
  res.et = list.some((e) => minute(e) > 90);
  // ---- goals: use the provider's running score after each goal ----
  const goals = list.filter((e) => { const t = evType(e); return t === "goal" || t === "owngoal" || t === "penaltygoal"; })
    .sort((x, y) => minute(x) - minute(y) || (Number(x.minute_added) || 0) - (Number(y.minute_added) || 0));
  const running = goals.every((g) => isInt(g.score_home) && isInt(g.score_away));
  const scoreAt = (maxMin) => {
    const upto = goals.filter((g) => minute(g) <= maxMin);
    if (running) { const last = upto[upto.length - 1]; return last ? [last.score_home, last.score_away] : [0, 0]; }
    // fallback: count by team, own goals credited to the opponent of team_id
    const s = [0, 0];
    for (const g of upto) { let i = side(g); if (i === null) return null; if (g.is_own_goal || evType(g) === "owngoal") i = 1 - i; s[i]++; }
    return s;
  };
  const rt = scoreAt(90);
  const ht = scoreAt(45);
  const all = scoreAt(1e9);
  if (!rt || !ht || !all || !ft || all[0] !== ft[0] || all[1] !== ft[1]) {
    res.reason = "goal events don't reconcile with the final score";
  } else { res.rt = rt; res.ht = ht; }
  // ---- cards: regular time only (incl. stoppage time) ----
  const cards = { FT: { y: [0, 0], r: [0, 0] }, H1: { y: [0, 0], r: [0, 0] }, H2: { y: [0, 0], r: [0, 0] } };
  let unattributed = 0;
  for (const e of list) {
    const t = evType(e);
    const isRed = t.includes("red") && t.includes("card");
    const isYellow = !isRed && t.includes("yellow");
    if (!isRed && !isYellow) continue;
    if (minute(e) > 90) continue;
    const i = side(e); if (i === null) { unattributed++; continue; }
    const half = minute(e) <= 45 ? "H1" : "H2";
    const k = isRed ? "r" : "y";
    cards.FT[k][i]++; cards[half][k][i]++;
  }
  const hasSubs = list.some((e) => evType(e).includes("substitution"));
  if (unattributed) res.reason += (res.reason ? "; " : "") + `${unattributed} card(s) without a team`;
  else if (hasSubs || goals.length) res.cards = cards; // a timeline with subs/goals is treated as complete
  res.ok = true;
  return res;
}

async function matchDetail(id, keys) {
  const [m, s, e] = await Promise.allSettled([
    cached(`pitch:match:${id}`, 600, () => pitch(`/v1/matches/${id}`, keys)),
    pitch(`/v1/matches/${id}/stats`, keys),
    pitch(`/v1/matches/${id}/events`, keys),
  ]);
  if (m.status === "rejected") throw m.reason;
  const match = m.value;
  const homeId = match.home_team?.id, awayId = match.away_team?.id;
  const ft = isInt(match.score_home) && isInt(match.score_away) ? [match.score_home, match.score_away] : null;
  const flags = [];
  const st = s.status === "fulfilled" ? parseStats(s.value) : null;
  if (!st) flags.push("Team stats unavailable from provider");
  const ev = e.status === "fulfilled" ? parseEvents(e.value?.events, homeId, awayId, ft) : { ok: false, reason: "events request failed" };
  if (ev.reason) flags.push("Events: " + ev.reason);
  if (ev.et) flags.push("Match went to extra time — only the first 90 minutes (+ stoppage) are used for goals & cards");
  let cards = { FT: null, H1: null, H2: null }, cardSource = null;
  if (ev.cards) { cards = ev.cards; cardSource = "events"; }
  else if (st && (st.cards.FT || st.cards.H1)) { cards = { FT: st.cards.FT, H1: st.cards.H1, H2: st.cards.H2 }; cardSource = "team stats"; }
  const corners = st ? st.corners : { FT: null, H1: null, H2: null };
  if (corners.FT && corners.H1 && corners.H2) {
    if (corners.H1[0] + corners.H2[0] !== corners.FT[0] || corners.H1[1] + corners.H2[1] !== corners.FT[1]) flags.push("Corner halves don't add up to the full-match figure (provider data) — each period uses its own figure");
  }
  if (ev.et && corners.FT) flags.push("Full-match corners may include extra time");
  const status = String(match.status || "").toLowerCase();
  const complete = status === "finished" && !!corners.FT && !!cards.FT && !!ev.ht;
  return {
    id, status, time: match.time_utc, ft, rt: ev.rt || (!ev.et ? ft : null), ht: ev.ht, htSource: ev.ht ? "events" : null, et: ev.et,
    home: slimTeam(match.home_team), away: slimTeam(match.away_team), referee: match.referee || null,
    corners, cards, cardSource, flags, complete, fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
//  8. Sources / diagnostics
// ---------------------------------------------------------------------
async function sources(keys) {
  const out = { checkedAt: new Date().toISOString(), providers: [], competitions: [], pitchLeagues: [] };
  // PitchAPI
  const p = { id: "pitch", name: "PitchAPI", keyConfigured: !!keys.pitch };
  const t0 = Date.now();
  try {
    mem.delete("pitch:leagues"); mem.delete("pitch:resolved"); LS.del("dsc:c:pitch:leagues");
    const leagues = await pitchLeagues(keys);
    p.ok = true; p.latencyMs = Date.now() - t0; p.detail = `${leagues.length} leagues available`;
    out.pitchLeagues = leagues.map((l) => ({ id: l.id, name: l.name, cc: l.cc, seasons: l.seasons.slice(0, 3) }));
    out.competitions = await cached("pitch:resolved", 3600, () => resolveCompetitions(keys));
  } catch (e) { p.ok = false; p.error = e.message; p.hint = e.hint; }
  out.providers.push(p);
  // football-data.org
  const f = { id: "fd", name: "football-data.org", keyConfigured: !!keys.fd };
  if (keys.fd) {
    const t1 = Date.now();
    try { const d = await fd("/competitions/PL", keys); f.ok = true; f.latencyMs = Date.now() - t1; f.detail = `Connected — current season ${d?.currentSeason?.startDate?.slice(0, 4) || ""}`; }
    catch (e) { f.ok = false; f.error = e.message; f.hint = e.hint; }
  }
  out.providers.push(f);
  return out;
}

// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
//  9. Router — the app calls Engine.call("fixtures?comp=PL") etc.
// ---------------------------------------------------------------------
const ID_RE = /^m_[A-Za-z0-9]{6}$/;

async function call(path) {
  const [route, qs] = String(path).split("?");
  const q = new URLSearchParams(qs || "");
  const keys = getKeys();
  if (route === "competitions") {
    const comps = await cached("pitch:resolved", 3600, () => resolveCompetitions(keys));
    return { competitions: comps.map(({ seasons, ...c }) => ({ ...c, season: seasons[0] || null })) };
  }
  if (route === "fixtures") {
    const code = (q.get("comp") || "").toUpperCase();
    if (code === "ALL") {
      const settled = await Promise.allSettled(COMPETITIONS.map((c) => fixtures(c.code, keys)));
      const errors = [];
      const list = settled.flatMap((r, i) => { if (r.status === "fulfilled") return r.value; errors.push({ comp: COMPETITIONS[i].code, error: r.reason.message }); return []; });
      if (!list.length && errors.length === COMPETITIONS.length) throw settled[0].reason;
      list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      return { fixtures: list, errors, generatedAt: new Date().toISOString() };
    }
    return { fixtures: await fixtures(code, keys), generatedAt: new Date().toISOString() };
  }
  if (route === "analysis") {
    const code = (q.get("comp") || "").toUpperCase(), id = q.get("match") || "";
    if (!ID_RE.test(id)) throw new ApiError(400, "BAD_ID", "Invalid match id.");
    return cached(`analysis:${code}:${id}`, 600, () => analysis(code, id, keys));
  }
  if (route === "match") {
    const id = q.get("id") || "";
    if (!ID_RE.test(id)) throw new ApiError(400, "BAD_ID", "Invalid match id.");
    return matchDetail(id, keys);
  }
  if (route === "sources") return sources(keys);
  if (route === "raw") {
    const id = q.get("id") || "", part = q.get("part") || "stats";
    if (!ID_RE.test(id)) throw new ApiError(400, "BAD_ID", "That isn't a match ID (it should look like m_ab12CD).");
    const p = part === "match" ? "" : part === "events" ? "/events" : "/stats";
    return { provider: "PitchAPI", endpoint: `/v1/matches/${id}${p}`, data: await pitch(`/v1/matches/${id}${p}`, keys) };
  }
  throw new ApiError(404, "NO_ROUTE", "Unknown request.");
}

function setLeagueOverride(code, leagueId) {
  const o = LS.get("dsc:leagueIds") || {};
  if (leagueId) o[code] = leagueId; else delete o[code];
  LS.set("dsc:leagueIds", o);
  mem.delete("pitch:resolved");
}

window.Engine = { call, refresh, setLeagueOverride, COMPETITIONS, _test: { parseStats, parseEvents, nameSim, crossCheck } };
})();
