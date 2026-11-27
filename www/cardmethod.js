/* =====================================================================
   DayleeStatCardz — Yellow Card Method (Johnny Poker method v1.5, applied)
   The app does the number work the method asks for and keeps the decision
   trail. It never invents a figure: anything it can't get is shown as
   UNKNOWN / U, and things only a person can check (weather, previews,
   eye test, prices) are recorded by you and time-stamped.
   Referee and team yellow-card tables are built free every morning on
   GitHub (scripts/daily-brief.mjs → cards.json).
   ===================================================================== */
"use strict";

const CM_URL = "https://raw.githubusercontent.com/iancouslfc-del/dayleestatcardz-app/daily-brief/cards.json";
const CM_DEF = { single: 4.0, double: 13.0, ref: 4.0 };
const CM_Z = 1.2816;                       // 80% Wilson range for historical rates
const CM_MIN_N = 5;                        // fewer comparable games than this = U / not estimable
const CM_BOOKS = ["Bet365", "Sky Bet", "Paddy Power", "Betfair", "William Hill", "Betfred", "Coral", "Ladbrokes", "BetVictor", "Betway", "Unibet", "BoyleSports", "Midnite", "Star Sports"];
const CM_ROLES = ["", "DM", "CM", "AM", "RB", "LB", "RWB", "LWB", "CB", "RW", "LW", "ST"];
const CM = { tables: null, at: 0, state: "idle", error: null, ctx: null };
const STEP_NAMES = ["Fixture, kick-off, competition, venue, slate size", "Referee appointment, sample and competition rate", "Both teams' own and opponent cards", "Stadium weather for the match window", "Preview, availability, likely starts and minutes", "Roles, midfield/full-back screen, fouls v fouls won", "Your names and eye-test notes", "All supplied prices scanned for discrepancies"];

// ---------- settings (with change log, as the method requires) ----------
const cmSettings = () => ({ ...CM_DEF, ...store.get("cmSet", {}) });
function cmChange(k, v) {
  const cur = cmSettings();
  if (!(v > 1) || v === cur[k]) return;
  const log = store.get("cmChanges", []);
  log.push({ at: new Date().toISOString(), field: k, from: cur[k], to: v });
  store.set("cmChanges", log);
  store.set("cmSet", { ...store.get("cmSet", {}), [k]: v });
}

// ---------- maths ----------
function parseOdds(t) {
  t = String(t || "").trim().toLowerCase();
  if (!t) return null;
  if (/^(evs?|evens)$/.test(t)) return 2;
  const f = t.match(/^(\d+(?:\.\d+)?)\s*[/-]\s*(\d+(?:\.\d+)?)$/);
  if (f && +f[2] > 0) return 1 + +f[1] / +f[2];
  const d = parseFloat(t);
  return d > 1 ? d : null;
}
const FRACS = [[1, 5], [2, 9], [1, 4], [2, 7], [1, 3], [4, 11], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [4, 6], [8, 11], [4, 5], [5, 6], [10, 11], [1, 1], [11, 10], [6, 5], [5, 4], [11, 8], [6, 4], [13, 8], [7, 4], [15, 8], [2, 1], [9, 4], [5, 2], [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1], [20, 1], [25, 1], [33, 1], [40, 1], [50, 1]];
function fracOf(d) { let best = null, e = 1e9; for (const [a, b] of FRACS) { const x = Math.abs(1 + a / b - d); if (x < e) { e = x; best = `${a}/${b}`; } } return e < 0.04 ? (best === "1/1" ? "evens" : best) : null; }
const oddsTxt = (d) => (d ? `${d.toFixed(2)}${fracOf(d) ? ` (${fracOf(d)})` : ""}` : "–");
function wilson(k, n, z = CM_Z) {
  if (!n) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pc = (x, dp = 0) => (x === null || x === undefined || !isFinite(x) ? "–" : (100 * x).toFixed(dp) + "%");
const f2 = (x) => (x === null || x === undefined || !isFinite(x) ? "–" : x.toFixed(2));
const evTxt = (x) => (x === null || !isFinite(x) ? "–" : (x >= 0 ? "+" : "") + (100 * x).toFixed(0) + "%");
const gradeFrom = (ratio, cuts) => cuts.reduce((g, c) => g + (ratio >= c ? 1 : 0), 0);
const RATIO_CUTS = [0.5, 0.8, 1.1, 1.5, 2.0];
const REF_CUTS = [0.8, 0.95, 1.05, 1.15, 1.3];

// ---------- data ----------
async function cmTables(force) {
  if (CM.tables && !force && Date.now() - CM.at < 10 * 60000) return CM.tables;
  if (!CM.tables) CM.tables = store.get("cmTables", null);
  try {
    const r = await window.Engine.fetchText(CM_URL + "?t=" + Date.now());
    if (r.status === 404) { CM.state = "missing"; return CM.tables; }
    if (r.status !== 200) throw new Error(r.status ? "GitHub error " + r.status : "No connection to GitHub.");
    const d = JSON.parse(r.body);
    if (!d || d.v !== 1) throw new Error("Card tables format not recognised — update the app.");
    CM.tables = d; CM.at = Date.now(); CM.state = "ok"; CM.error = null;
    store.set("cmTables", d);
  } catch (e) { CM.error = e.message; CM.state = CM.tables ? "ok" : "error"; }
  return CM.tables;
}
const fxState = (id) => store.get("cm:" + id, {});
function fxSave(id, mut) { const s = fxState(id); mut(s); store.set("cm:" + id, s); return s; }

function compTable(code) {
  const C = CM.tables && CM.tables.comps && CM.tables.comps[code];
  if (!C || !C.games) return null;
  return { ...C, ycpg: C.yc / C.games, rcpg: C.rc / C.games };
}
function refStats(C, name) {
  if (!C || !name) return null;
  const R = C.refs[name] || Object.entries(C.refs).find(([k]) => tName(k) === tName(name))?.[1];
  return R ? { ...R, ycpg: R.yc / R.n } : { n: 0, yc: 0, rc: 0, last: [], ycpg: null };
}
function teamStats(C, team) {
  if (!C || !team) return null;
  const T = C.teams[team.id] || Object.values(C.teams).find((t) => tName(t.name) === tName(team.name));
  return T || null;
}

// Triage — ordinal research priority, never a probability (method §0).
function cmTriage({ code, referee, home, away, busy }) {
  const s = cmSettings(), C = compTable(code);
  const R = refStats(C, referee), H = teamStats(C, home), Aw = teamStats(C, away);
  const half = C ? C.ycpg / 2 : null;
  const pair = (own, opp) => {
    if (!own || !opp || !own.n || !opp.n || half === null) return "unknown";
    const a = own.own / own.n, b = opp.opp / opp.n;
    if (a >= half && b >= half) return "high"; if (a < half && b < half) return "low"; return "mixed";
  };
  const p1 = pair(H, Aw), p2 = pair(Aw, H); // home own vs away opponent cards; away own vs home opponent cards
  const refKnown = R && R.n >= CM_MIN_N;
  let rating = "RESERVE", reason;
  if (!referee) reason = "Referee not appointed / not listed yet — UNRESOLVED.";
  else if (!R || !R.n) reason = `No ${C ? C.name : ""} matches found for ${referee} this season — UNRESOLVED.`;
  else if (!refKnown) reason = `Referee sample only ${R.n} — too small to rank confidently.`;
  if (refKnown && R.ycpg >= s.ref && (p1 === "high" || p2 === "high")) { rating = "PRIORITY"; reason = `Referee ${f2(R.ycpg)} YC/game (n ${R.n}) at/above your ${s.ref} reference and a team pair converges high.`; }
  else if (refKnown && R.ycpg >= s.ref) reason = `Strict referee (${f2(R.ycpg)}, n ${R.n}) but team card profiles are ${p1}/${p2} — a strict referee alone can't create a priority.`;
  else if (refKnown && R.ycpg < s.ref && p1 !== "high" && p2 !== "high") {
    if (busy) { rating = "DEPRIORITISED"; reason = `Referee ${f2(R.ycpg)} below ${s.ref} and no converging team pair — research allocation only, not a player PASS.`; }
    else reason = `Referee ${f2(R.ycpg)} below ${s.ref}: scrutiny, not rejection, on a small slate.`;
  } else if (refKnown) reason = `Referee ${f2(R.ycpg)} below ${s.ref} but a team pair converges high — mixed evidence.`;
  const nMin = Math.min(R ? R.n : 0, H ? H.n : 0, Aw ? Aw.n : 0);
  const conf = nMin >= 8 ? "HIGH" : nMin >= CM_MIN_N ? "MEDIUM" : "LOW";
  return { rating, reason, conf, C, R, H, A: Aw, p1, p2 };
}

// Every player's comparable-game record for one side (this season, every club competition the app sees).
function cmPlayers(A, key) {
  const side = A[key], team = side.team;
  const matches = [...plSample(A, key, "all")].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const recs = new Map();
  for (const m of matches) {
    const pd = PL.data.get(m.id); if (!pd) continue;
    const isHome = m.home.id === team.id || tName(m.home.name) === tName(team.name);
    const tId = isHome ? pd.homeId : pd.awayId;
    for (const p of pd.players) {
      if (!p.t || p.t !== tId) continue;
      let r = recs.get(p.id);
      if (!r) { r = { id: p.id, name: p.n, img: p.img, pos: p.pos, team, side: key, g: [] }; recs.set(p.id, r); }
      if (!r.img && p.img) r.img = p.img;
      const zf = p.zf || [];
      r.g.push({ m, opp: isHome ? m.away : m.home, home: isHome, own: m.own !== false, min: p.s.min ?? null,
        fc: p.s.fouls ?? null, fcZ: zf.includes("fouls"), fw: p.s.fouled ?? null, fwZ: zf.includes("fouled"),
        yc: pd.cardsOk ? (p.s.yc ?? 0) : null, rc: pd.cardsOk ? (p.s.rc ?? 0) : null });
    }
  }
  const out = [];
  for (const r of recs.values()) {
    const cg = r.g.filter((x) => x.min !== null && x.min >= 45), short = r.g.filter((x) => x.min !== null && x.min < 45);
    const stat = (list) => {
      const card = list.filter((x) => x.yc !== null), fc = list.filter((x) => x.fc !== null), fw = list.filter((x) => x.fw !== null);
      const sum = (l, k) => l.reduce((a, x) => a + x[k], 0);
      return { n: list.length, cardN: card.length, booked: card.filter((x) => x.yc > 0).length, reds: card.filter((x) => x.rc > 0).length,
        fcN: fc.length, fc: sum(fc, "fc"), fcMin: sum(fc, "min"), fcZ: fc.filter((x) => x.fcZ).length,
        fc1: fc.filter((x) => x.fc >= 1).length, fc2: fc.filter((x) => x.fc >= 2).length, fc3: fc.filter((x) => x.fc >= 3).length,
        fwN: fw.length, fw: sum(fw, "fw"), fwMin: sum(fw, "min") };
    };
    const all = stat(cg), lg = stat(cg.filter((x) => x.own));
    out.push({ ...r, cg, short, all, lg, fc90: all.fcMin ? (all.fc / all.fcMin) * 90 : null, fw90: all.fwMin ? (all.fw / all.fwMin) * 90 : null,
      bookRate: all.cardN ? all.booked / all.cardN : null, comps: [...new Set(cg.filter((x) => !x.own).map((x) => x.m.compShort).filter(Boolean))] });
  }
  return out;
}
function cmStatus(fxId, key, pid) {
  const L = PL.lineups.get(fxId), s = L && L[key];
  if (!s || !s.starters || !s.starters.length) return { txt: "Line-up unknown", start: null, confirmed: false };
  if (s.starters.includes(pid)) return { txt: s.confirmed ? "Confirmed starter" : "Predicted starter", start: true, confirmed: s.confirmed };
  if ((s.subs || []).includes(pid)) return { txt: s.confirmed ? "Bench (confirmed)" : "Predicted bench", start: false, confirmed: s.confirmed };
  return { txt: "Not in the listed squad", start: false, confirmed: s.confirmed };
}

// Grades A–F (method §10) + historical range + price verdict (§11, §16).
function cmEval(p, X) {
  const st = fxState(X.id), s = cmSettings();
  const out = { grades: {}, reasons: {} };
  const set = (k, g, why) => { out.grades[k] = g; out.reasons[k] = why; };
  // A booking propensity
  if (p.all.cardN >= CM_MIN_N && X.bookBase) {
    const r = p.bookRate / X.bookBase.v;
    set("A", gradeFrom(r, RATIO_CUTS), `Booked in ${p.all.booked}/${p.all.cardN} comparable games (${pc(p.bookRate)}) v ${X.bookBase.label} ${pc(X.bookBase.v)} — ${r.toFixed(2)}×.`);
  } else set("A", "U", `Only ${p.all.cardN} comparable games with card data — not enough to grade.`);
  // B direct matchup: only from opponents YOU map (method: confirm the actual channel)
  const opps = (st.opps && st.opps[p.id]) || [];
  const oppRecs = X.oppPlayers(p.side).filter((o) => opps.includes(o.id) && o.fw90 !== null && o.all.fwN >= 3);
  if (oppRecs.length && X.fwBase) {
    const fw = oppRecs.reduce((a, o) => a + o.fw90, 0) / oppRecs.length, r = fw / X.fwBase;
    set("B", gradeFrom(r, RATIO_CUTS), `Mapped opponent${oppRecs.length > 1 ? "s" : ""} ${oppRecs.map((o) => o.name).join(", ")} win ${f2(fw)} fouls/90 v ${f2(X.fwBase)} average — ${r.toFixed(2)}×.`);
  } else set("B", "U", opps.length ? "Mapped opponent has too little fouls-won data." : "Pick his likely direct opponent(s) below to grade the matchup.");
  // C foul profile
  if (p.all.fcN >= CM_MIN_N && p.all.fcMin >= 300 && X.fcBase) {
    const r = p.fc90 / X.fcBase;
    set("C", gradeFrom(r, RATIO_CUTS), `${f2(p.fc90)} fouls/90 (${p.all.fc} in ${p.all.fcMin} min) v ${f2(X.fcBase)} for outfield players in this fixture's teams — ${r.toFixed(2)}×.${p.all.fcZ ? ` ${p.all.fcZ} game(s) had fouls missing from the provider (shown as 0).` : ""}`);
  } else set("C", "U", "Not enough fouls data (needs 5 games / 300 minutes).");
  // D role / game script — your judgement
  const dg = st.D && st.D[p.id];
  set("D", dg === undefined || dg === "" ? "U" : +dg, dg === undefined || dg === "" ? "Your call: set his role and grade the tactical/game-script case." : `Your grade${st.role && st.role[p.id] ? ` (role ${st.role[p.id]})` : ""}.`);
  // E referee
  if (X.tri.R && X.tri.R.n >= 3 && X.tri.C) {
    const r = X.tri.R.ycpg / X.tri.C.ycpg;
    set("E", gradeFrom(r, REF_CUTS), `${X.referee}: ${f2(X.tri.R.ycpg)} YC/game (n ${X.tri.R.n}) v competition ${f2(X.tri.C.ycpg)} — ${r.toFixed(2)}×.${X.tri.R.n < CM_MIN_N ? " Small sample." : ""}`);
  } else set("E", "U", X.referee ? "Referee's record not available yet." : "Referee not appointed yet.");
  // F history / behaviour — your judgement
  const fg = st.F && st.F[p.id];
  set("F", fg === undefined || fg === "" ? "U" : +fg, fg === undefined || fg === "" ? "Your call: sourced, current, specific history only." : "Your grade.");
  const W = { A: 25, B: 25, C: 20, D: 15, E: 10, F: 5 };
  let pts = 0, cov = 0;
  for (const k in W) if (out.grades[k] !== "U") { pts += (out.grades[k] / 5) * W[k]; cov += W[k]; }
  out.points = pts; out.coverage = cov; out.score = cov ? (100 * pts) / cov : null;
  out.conf = cov >= 80 && p.all.cardN >= 10 && X.tri.R && X.tri.R.n >= CM_MIN_N ? "HIGH" : cov >= 60 && p.all.cardN >= 6 ? "MEDIUM" : "LOW";
  out.range = p.all.cardN >= CM_MIN_N ? wilson(p.all.booked, p.all.cardN) : null;
  // prices
  const books = ((st.prices && st.prices[p.id]) || []).map((b) => ({ ...b, d: parseOdds(b.o) })).filter((b) => b.d);
  out.books = books;
  if (books.length) {
    const hi = Math.max(...books.map((b) => b.d)), lo = Math.min(...books.map((b) => b.d));
    out.best = books.find((b) => b.d === hi); out.gap = books.length > 1 ? (hi / lo - 1) * 100 : null;
    out.flag = out.gap === null ? null : out.gap >= 50 ? "PRIORITY INVESTIGATION" : out.gap >= 25 ? "REVIEW" : "below flag";
    const D = hi; out.breakEven = 1 / D;
    out.minOdds = out.range && out.range[0] > 0 ? Math.max(s.single, 1 / out.range[0]) : s.single;
    if (out.range) out.ev = [out.range[0] * D - 1, out.range[1] * D - 1];
    if (D < s.single) out.verdict = ["PASS", `Below your ${oddsTxt(s.single)} singles floor.`, "BELOW FLOOR"];
    else if (!out.range) out.verdict = ["WATCH", "Booking range not estimable — too few comparable games."];
    else if (out.conf === "LOW") out.verdict = ["WATCH", "Evidence coverage/confidence LOW — research the gaps (matchup, role, referee) first."];
    else if (out.ev[0] > 0) out.verdict = ["BET", `Positive even at the low end of his historical range (${pc(out.range[0])} v break-even ${pc(out.breakEven, 1)}).`];
    else if (out.ev[1] < 0) out.verdict = ["PASS", `Even the top of his range (${pc(out.range[1])}) is under break-even ${pc(out.breakEven, 1)}.`, "NO VALUE"];
    else out.verdict = ["WATCH", `Range ${pc(out.range[0])}–${pc(out.range[1])} spans break-even ${pc(out.breakEven, 1)} — needs a better price or better evidence.`];
    if (out.verdict[0] === "BET" && !X.status(p).confirmed) out.verdict[1] += " PROVISIONAL until the line-up is confirmed.";
  }
  return out;
}

// Context for one fixture.
async function cmLoad(comp, id) {
  const A = await api(`analysis?comp=${comp}&match=${id}`);
  await Promise.all([cmTables(false), plLineups(id), loadBrief ? loadBrief(false).catch(() => null) : null]);
  await loadDetails([...new Set([...A.home.sample, ...A.away.sample].map((m) => m.id))], () => {});
  await plLoad(plIds(A, "all"), () => {});
  const day = fmtDay(A.fixture.time);
  const slate = BR.data ? BR.data.fixtures.filter((f) => fmtDay(f.time) === day).length : null;
  const busy = slate !== null && slate > 4;
  const tri = cmTriage({ code: comp, referee: A.fixture.referee, home: A.home.team, away: A.away.team, busy });
  const players = { home: cmPlayers(A, "home"), away: cmPlayers(A, "away") };
  const out = [...players.home, ...players.away].filter((p) => p.pos !== 0);
  const pool = (k, m) => { let a = 0, b = 0; for (const p of out) { a += p.all[k]; b += p.all[m]; } return b ? (a / b) * 90 : null; };
  let bk = 0, bn = 0; for (const p of out) { bk += p.all.booked; bn += p.all.cardN; }
  const bookBase = tri.C ? { v: tri.C.ycpg / 2 / 11, label: `${tri.C.name} average (~${f2(tri.C.ycpg)} YC/game ÷ 22 players)` } : bn ? { v: bk / bn, label: "both squads' average" } : null;
  const X = { comp, id, A, tri, players, busy, slate, referee: A.fixture.referee, bookBase, fcBase: pool("fc", "fcMin"), fwBase: pool("fw", "fwMin"),
    oppPlayers: (side) => players[side === "home" ? "away" : "home"].filter((p) => p.pos !== 0),
    status: (p) => cmStatus(id, p.side, p.id) };
  CM.ctx = X;
  return X;
}

// ---------- screens ----------
const vchip = (v) => `<span class="vchip v-${v[0].toLowerCase()}">${v[0]}${v[2] ? " — " + v[2] : ""}</span>`;
const ratingChip = (r) => `<span class="rchip r-${r.toLowerCase()}">${r}</span>`;
const gtxt = (g) => (g === "U" ? "U" : String(g));

async function viewMethod(comp, id, pid) {
  setNav("home");
  app().innerHTML = `<a class="back" href="#/match/${comp}/${id}">${ICON.back} Match</a>${skeleton(1, 120)}${skeleton(4, 90)}`;
  let X;
  try { await loadComps(); X = await cmLoad(comp, id); }
  catch (e) { if (S.route === "method") app().innerHTML = `<a class="back" href="#/">${ICON.back} Home</a>` + errorBox(e, "reload"); return; }
  if (S.route !== "method") return;
  return pid ? renderCandidate(X, pid) : renderMethod(X);
}

function cmChecks(X) {
  const st = fxState(X.id), L = PL.lineups.get(X.id);
  const lu = L && L.home && L.home.starters && L.home.starters.length ? (L.home.confirmed && L.away && L.away.confirmed ? ["done", "Confirmed XIs"] : ["prov", "Predicted XIs only"]) : ["na", "No line-ups from provider yet"];
  const ref = !X.referee ? ["na", "Not appointed / not listed"] : X.tri.R && X.tri.R.n ? [X.tri.R.n >= CM_MIN_N ? "done" : "prov", `${f2(X.tri.R.ycpg)} YC/game, n ${X.tri.R.n}`] : ["na", "No record in the card tables yet"];
  const teams = X.tri.H && X.tri.A ? [Math.min(X.tri.H.n, X.tri.A.n) >= CM_MIN_N ? "done" : "prov", `Season tables n ${X.tri.H.n} / ${X.tri.A.n}`] : ["na", "Card tables not available yet"];
  const wx = st.weather ? ["done", `${st.weather.s} — recorded ${fmtTime(st.weather.at)}`] : ["todo", "Not recorded yet — tap to check"];
  const prev = st.preview ? ["done", "Preview read " + fmtTime(st.preview.at)] : ["todo", "Read the Sports Mole preview"];
  const picks = Object.keys(st.picks || {}).length;
  const priced = Object.keys(st.prices || {}).filter((k) => (st.prices[k] || []).length).length;
  return [["done", `${fmtDay(X.A.fixture.time)} ${fmtTime(X.A.fixture.time)} · ${X.slate === null ? "slate size unknown" : `${X.slate} fixture${X.slate === 1 ? "" : "s"} that day → ${X.busy ? "BUSY" : "SMALL"}`}`], ref, teams, wx,
    [lu[0] === "done" && st.preview ? "done" : lu[0] === "na" && !st.preview ? "todo" : "prov", `${lu[1]}${st.preview ? " · preview read" : " · preview not read"}`],
    [X.players.home.length + X.players.away.length ? "done" : "na", `${X.players.home.length + X.players.away.length} players screened`],
    [picks ? "done" : "todo", picks ? `${picks} of your names registered` : "None registered yet (optional)"],
    [priced ? "done" : "todo", priced ? `${priced} players priced` : "No prices entered — assessment is INDEPENDENT of prices"]];
}
const STEP_ICON = { done: "✓", prov: "◐", na: "–", todo: "○" };

function renderMethod(X) {
  const A = X.A, f = A.fixture, st = fxState(X.id), s = cmSettings(), T = X.tri;
  const checks = cmChecks(X);
  const evals = [];
  for (const side of ["home", "away"]) for (const p of X.players[side]) if (p.pos !== 0) evals.push({ p, e: cmEval(p, X), status: X.status(p) });
  const likely = evals.filter((x) => x.status.start !== false && x.p.cg.length >= 3);
  const ranked = [...likely].sort((a, b) => (b.e.score ?? -1) * b.e.coverage - (a.e.score ?? -1) * a.e.coverage);
  const shortlist = ranked.filter((x) => x.e.coverage >= 45 && (x.e.score ?? 0) >= 50).slice(0, 4);
  const exposure = Object.values(st.prices || {}).some((l) => l && l.length) ? "MARKET-AWARE" : "INDEPENDENT";
  let h = `<a class="back" href="#/match/${X.comp}/${X.id}">${ICON.back} Match</a>
  <div class="card hero cm-hero"><div class="kicker-s">Yellow Card Method · Johnny Poker v1.5</div>
    <div class="cm-fx">${crest(A.home.team)}<b>${esc(A.home.team.name)}</b><span>v</span><b>${esc(A.away.team.name)}</b>${crest(A.away.team)}</div>
    <p>${kickoff(f.time)}${f.stadium ? ` · ${esc(f.stadium)}` : ""}${f.referee ? ` · Ref ${esc(f.referee)}` : ""}</p>
    <div class="cm-tags">${ratingChip(T.rating)}<span class="tag">${T.conf} confidence</span><span class="tag">${exposure}</span><span class="tag">${X.busy ? "BUSY" : "SMALL"} slate</span></div>
    <p class="cm-reason">${esc(T.reason || "")}</p></div>`;
  if (CM.state !== "ok" && !CM.tables) h += `<div class="card note small"><b>Referee & team card tables aren't on GitHub yet.</b> They're built by the morning Daily Brief run — open GitHub → Actions → Daily Brief → Run workflow. Until then those checks stay UNRESOLVED.</div>`;
  // 8 steps
  h += `<div class="section-title"><h2>8 mandatory steps</h2><span class="aside">✓ done · ◐ provisional · ○ to do · – unavailable</span></div><div class="card cm-steps">`;
  checks.forEach((c, i) => { h += `<div class="cm-step s-${c[0]}"><i>${STEP_ICON[c[0]]}</i><div><b>${i + 1}. ${STEP_NAMES[i]}</b><span>${esc(c[1])}</span></div></div>`; });
  h += `</div>`;
  // referee + team cards
  const R = T.R, C = T.C;
  h += `<div class="section-title"><h2>Referee & team cards</h2><span class="aside">${C ? `${esc(C.name)} ${esc(C.season || "")} · ${C.games} games` : "tables pending"}</span></div><div class="card cm-tab">`;
  h += `<div class="cm-row hd"><span></span><span>YC/game</span><span>n</span></div>`;
  h += `<div class="cm-row"><span>Referee${f.referee ? ` — ${esc(f.referee)}` : ""}</span><b class="${R && R.n && R.ycpg >= s.ref ? "hot" : ""}">${R && R.n ? f2(R.ycpg) : "UNRESOLVED"}</b><em>${R ? R.n : "–"}</em></div>`;
  h += `<div class="cm-row"><span>Competition benchmark</span><b>${C ? f2(C.ycpg) : "–"}</b><em>${C ? C.games : "–"}</em></div>`;
  h += `<div class="cm-row"><span>Your caution reference</span><b>${f2(s.ref)}</b><em></em></div>`;
  const trow = (lbl, T0, k) => `<div class="cm-row"><span>${lbl}</span><b>${T0 && T0[k + "n"] !== undefined ? "" : ""}${T0 ? f2(T0[k] / T0.n) : "–"}</b><em>${T0 ? T0.n : "–"}</em></div>`;
  h += `<div class="cm-sub">Season, this competition, all venues</div>`;
  h += trow(`${esc(A.home.team.name)} — own cards`, T.H, "own") + trow(`${esc(A.home.team.name)} — opponents' cards`, T.H, "opp");
  h += trow(`${esc(A.away.team.name)} — own cards`, T.A, "own") + trow(`${esc(A.away.team.name)} — opponents' cards`, T.A, "opp");
  const vh = sideTotals(A.home, "cards", "FT"), va = sideTotals(A.away, "cards", "FT");
  h += `<div class="cm-sub">Venue split (last ${A.home.sample.length} home / ${A.away.sample.length} away) — context only</div>`;
  h += `<div class="cm-row"><span>${esc(A.home.team.name)} at home — own / opp</span><b>${vh.n ? `${f2(vh.y[0] / vh.n)} / ${f2(vh.y[1] / vh.n)}` : "–"}</b><em>${vh.n}</em></div>`;
  h += `<div class="cm-row"><span>${esc(A.away.team.name)} away — own / opp</span><b>${va.n ? `${f2(va.y[0] / va.n)} / ${f2(va.y[1] / va.n)}` : "–"}</b><em>${va.n}</em></div>`;
  const pairTxt = { high: "converging HIGH", low: "converging low", mixed: "conflicting", unknown: "unknown" };
  h += `<div class="cm-pairs"><div><b>${esc(A.home.team.name)} own v ${esc(A.away.team.name)} opponents:</b> ${pairTxt[T.p1]}</div><div><b>${esc(A.away.team.name)} own v ${esc(A.home.team.name)} opponents:</b> ${pairTxt[T.p2]}</div><div class="dim">Read as pairs — never added together into a "card total".</div></div>`;
  if (R && R.last && R.last.length) h += `<details class="cm-last"><summary>Referee's last ${R.last.length} games in this competition</summary>${R.last.map((g) => `<div><span>${esc(g[0])}</span><span>${esc(g[1])} v ${esc(g[2])}</span><b>${g[3]} YC</b></div>`).join("")}</details>`;
  h += `</div>`;
  // weather + preview (person checks)
  const q = encodeURIComponent(`${A.home.team.name} vs ${A.away.team.name} prediction team news sports mole`);
  const wq = encodeURIComponent(`weather ${f.stadium || A.home.team.name + " stadium"} ${new Date(f.time).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`);
  h += `<div class="section-title"><h2>Your checks</h2><span class="aside">time-stamped in your log</span></div><div class="card cm-checks">
    <div class="cm-chk"><b>4 · Weather gate</b><a class="link" href="https://www.google.com/search?q=${wq}">Check forecast ↗</a>
      <div class="cm-seg">${["GREEN", "AMBER", "RED"].map((w) => `<button class="${st.weather && st.weather.s === w ? "on w-" + w.toLowerCase() : ""}" data-action="cmWeather" data-w="${w}">${w === "RED" ? "RED / HOLD" : w}</button>`).join("")}</div>
      <span class="dim">${st.weather ? `Recorded ${fmtDay(st.weather.at)} ${fmtTime(st.weather.at)}. Recheck with confirmed line-ups.` : "No automatic rain/snow points — note what it changes for each candidate."}</span></div>
    <div class="cm-chk"><b>5 · Preview & team news</b><a class="link" href="https://www.google.com/search?q=${q}">Sports Mole preview ↗</a>
      <button class="cm-toggle ${st.preview ? "on" : ""}" data-action="cmPreview">${st.preview ? "✓ Preview read" : "Mark preview read"}</button>
      <span class="dim">Official confirmed XI beats Sports Mole; Sports Mole beats the provider's predicted XI. Flag injury conflicts.</span></div></div>`;
  // shortlist
  h += `<div class="section-title"><h2>Shortlist</h2><span class="aside">up to 4 · zero is a valid result</span></div>`;
  if (!shortlist.length) h += `<div class="card note small">No player has enough graded evidence (coverage 45+ and score 50+) to shortlist yet. Map direct opponents and set roles on the strongest names in the screen below — or accept no shortlist.</div>`;
  shortlist.forEach((x, i) => { h += cmCandRow(X, x, i + 1); });
  // your names
  const picks = evals.filter((x) => st.picks && st.picks[x.p.id]);
  if (picks.length) h += `<div class="section-title"><h2>Your names</h2><span class="aside">assessed, never auto-selected</span></div>` + picks.map((x) => cmCandRow(X, x, null)).join("");
  // discrepancy scan
  const priced = evals.filter((x) => x.e.books.length);
  if (priced.length) {
    h += `<div class="section-title"><h2>Price discrepancy scan</h2><span class="aside">gap ≥25% review · ≥50% priority</span></div><div class="card cm-tab">`;
    h += `<div class="cm-row hd"><span>Player</span><span>Best</span><span>Gap</span></div>`;
    for (const x of priced.sort((a, b) => (b.e.gap || 0) - (a.e.gap || 0))) h += `<a class="cm-row" href="#/method/${X.comp}/${X.id}/${encodeURIComponent(x.p.id)}"><span>${esc(x.p.name)}<small>${x.e.books.map((b) => `${esc(b.b)} ${oddsTxt(b.d)}`).join(" · ")}</small></span><b>${oddsTxt(x.e.best.d)}</b><em class="${x.e.gap >= 50 ? "hot" : x.e.gap >= 25 ? "warm" : ""}">${x.e.gap === null ? "1 book" : x.e.gap.toFixed(0) + "%"}</em></a>`;
    h += `<div class="dim small" style="padding:8px 2px 0">A gap shows a price difference, not an edge. Each flag needs a verdict on the player page.</div></div>`;
  }
  // positional screen
  h += `<div class="section-title"><h2>Positional screen</h2><span class="aside">every likely starter · tap for the full block</span></div>`;
  for (const side of ["home", "away"]) {
    const team = A[side].team;
    const list = evals.filter((x) => x.p.side === side).sort((a, b) => (b.status.start === true) - (a.status.start === true) || (b.p.fc90 ?? -1) - (a.p.fc90 ?? -1));
    h += `<div class="card cm-screen"><div class="cm-screen-h">${crest(team)}<b>${esc(team.name)}</b><span>FC/90 · booked · flags</span></div>`;
    for (const x of list) {
      const p = x.p, flags = [];
      if ((p.pos === 1 || p.pos === 2) && p.all.fcN && p.all.fc / p.all.fcN > 1) flags.push(p.pos === 2 ? "MID >1 FC/game" : "DEF >1 FC/game");
      if (p.short.length) flags.push(`${p.short.length} short app${p.short.length > 1 ? "s" : ""}`);
      if (st.picks && st.picks[p.id]) flags.push("★ yours");
      h += `<a class="cm-pl ${x.status.start === false ? "dimmed" : ""}" href="#/method/${X.comp}/${X.id}/${encodeURIComponent(p.id)}"><span class="pos">${POS[p.pos] || "?"}</span><span class="nm">${esc(p.name)}<small>${esc(x.status.txt)} · ${p.cg.length} games 45+</small></span><b>${f2(p.fc90)}</b><em>${p.all.cardN ? `${p.all.booked}/${p.all.cardN}` : "–"}</em><i>${flags.map(esc).join(" · ")}</i></a>`;
    }
    h += `</div>`;
  }
  h += `<div class="cm-actions"><button class="btn primary" data-action="cmFreeze">Freeze this assessment</button><a class="btn" href="#/cardlog">Card log</a></div>`;
  h += `<div class="note card small"><b>How the app applies the method.</b> Comparable games = 45+ minutes this season, every club competition the app sees (league and European rates shown separately on each player). Grades A, C and E are calculated against the right comparison group; B needs you to map his direct opponent; D and F are your judgement and stay <b>U</b> until you set them — never quietly filled. The booking range is his historical rate with an 80% range: descriptive, not a forecast, and never adjusted by the app. Floors: singles ${oddsTxt(s.single)}, doubles ${oddsTxt(s.double)}. 18+ · BeGambleAware.org</div>`;
  app().innerHTML = h;
}

function cmCandRow(X, x, rank) {
  const p = x.p, e = x.e;
  return `<a class="card cm-cand" href="#/method/${X.comp}/${X.id}/${encodeURIComponent(p.id)}">
    <div class="cm-cand-top">${rank ? `<span class="rank">${rank}</span>` : ""}${playerPhoto(p, p.team)}<div class="cm-who"><b>${esc(p.name)}</b><span>${esc(p.team.name)} · ${esc(x.status.txt)}</span></div>
      <div class="cm-score"><b>${e.coverage ? e.points.toFixed(0) : "–"}</b><span>of ${e.coverage} assessed</span></div></div>
    <div class="cm-grades">${["A", "B", "C", "D", "E", "F"].map((k) => `<i class="${e.grades[k] === "U" ? "u" : "g" + e.grades[k]}">${k}<b>${gtxt(e.grades[k])}</b></i>`).join("")}</div>
    <div class="cm-line"><span>Booked ${p.all.booked}/${p.all.cardN} · range ${e.range ? `${pc(e.range[0])}–${pc(e.range[1])}` : "not estimable"} · ${e.conf}</span>${e.verdict ? vchip(e.verdict) : `<span class="vchip v-none">no price</span>`}</div></a>`;
}

function renderCandidate(X, pid) {
  const all = [...X.players.home, ...X.players.away];
  const p = all.find((x) => String(x.id) === String(pid));
  const back = `<a class="back" href="#/method/${X.comp}/${X.id}">${ICON.back} Method</a>`;
  if (!p) { app().innerHTML = back + `<div class="card empty"><h3>Player not found</h3><p>No stat lines for this player in this season's games.</p></div>`; return; }
  const st = fxState(X.id), e = cmEval(p, X), status = X.status(p), s = cmSettings();
  const opp = X.oppPlayers(p.side).filter((o) => o.cg.length >= 3).sort((a, b) => (b.fw90 ?? -1) - (a.fw90 ?? -1));
  const myOpps = (st.opps && st.opps[p.id]) || [];
  const W = { A: 25, B: 25, C: 20, D: 15, E: 10, F: 5 }, NAMES = { A: "Booking propensity", B: "Direct matchup", C: "Foul / disciplinary profile", D: "Tactical role / game script", E: "Referee environment", F: "Relevant history / behaviour" };
  let h = back + `<div class="card cm-p">${playerPhoto(p, p.team)}<div class="cm-who"><b>${esc(p.name)}</b><span>${esc(p.team.name)} · ${POS[p.pos] === "M" ? "Midfielder" : POS[p.pos] === "D" ? "Defender" : POS[p.pos] === "A" ? "Forward" : "Player"}</span><span class="${status.confirmed && status.start ? "ok-t" : ""}">${esc(status.txt)}</span></div>
    <button class="cm-star ${st.picks && st.picks[p.id] ? "on" : ""}" data-action="cmPick" data-pid="${esc(p.id)}">${st.picks && st.picks[p.id] ? "★ Your name" : "☆ Add as your name"}</button></div>`;
  // evidence table
  const row = (lbl, a, b) => `<div class="cm-row"><span>${lbl}</span><b>${a}</b><em>${b}</em></div>`;
  h += `<div class="section-title"><h2>Evidence</h2><span class="aside">45+ min games this season</span></div><div class="card cm-tab">`;
  h += `<div class="cm-row hd"><span></span><span>All club comps</span><span>League only</span></div>`;
  h += row("Comparable games (45+ min)", p.all.n, p.lg.n) + row("Booked (games with a yellow)", p.all.cardN ? `${p.all.booked}/${p.all.cardN}` : "–", p.lg.cardN ? `${p.lg.booked}/${p.lg.cardN}` : "–");
  h += row("Reds", p.all.reds, p.lg.reds) + row("Fouls committed per game", p.all.fcN ? f2(p.all.fc / p.all.fcN) : "–", p.lg.fcN ? f2(p.lg.fc / p.lg.fcN) : "–");
  h += row("Fouls committed per 90", f2(p.fc90), p.lg.fcMin ? f2((p.lg.fc / p.lg.fcMin) * 90) : "–") + row("Fouls won per 90", f2(p.fw90), p.lg.fwMin ? f2((p.lg.fw / p.lg.fwMin) * 90) : "–");
  h += row("Fouls 1+ / 2+ / 3+", p.all.fcN ? `${p.all.fc1} / ${p.all.fc2} / ${p.all.fc3} of ${p.all.fcN}` : "–", p.lg.fcN ? `${p.lg.fc1} / ${p.lg.fc2} / ${p.lg.fc3} of ${p.lg.fcN}` : "–");
  h += row("Short / sub appearances (<45)", p.short.length, "");
  h += `<div class="dim small" style="padding:6px 2px 0">${p.comps.length ? `Includes ${esc(p.comps.join(", "))} games. ` : ""}Starts aren't listed by the provider, so 45+ minutes is used as the start proxy.${p.all.fcZ ? ` ${p.all.fcZ} game(s) had fouls missing (provider shows 0) — a coverage limit.` : ""}</div>`;
  h += `<div class="cm-games">${p.cg.slice(0, 10).map((g) => `<div class="${g.yc > 0 ? "bk" : g.yc === null ? "unk" : ""}"><b>${g.fc === null ? "–" : g.fc}${g.fcZ ? "*" : ""}</b><span>${g.yc === null ? "?" : g.yc > 0 ? "🟨" : "·"}</span><em>${g.min}'</em><small>${esc(new Date(g.m.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }))}${g.own ? "" : " " + esc(g.m.compShort || "")}</small></div>`).join("")}</div>
    <div class="dim small">Last 10 comparable games, newest first: fouls committed · card · minutes. * = provider didn't list fouls.</div></div>`;
  // grades
  h += `<div class="section-title"><h2>Grades</h2><span class="aside">${e.score === null ? "no grades yet" : `${e.points.toFixed(1)} points of ${e.coverage} assessed`}</span></div><div class="card cm-gr">`;
  for (const k of ["A", "B", "C", "D", "E", "F"]) {
    const g = e.grades[k];
    let ctl = "";
    if (k === "D") ctl = `<select data-cm="role" data-pid="${esc(p.id)}">${CM_ROLES.map((r) => `<option value="${r}" ${((st.role || {})[p.id] || "") === r ? "selected" : ""}>${r || "Role…"}</option>`).join("")}</select>`;
    if (k === "D" || k === "F") ctl += `<select data-cm="${k}" data-pid="${esc(p.id)}">${["", 0, 1, 2, 3, 4, 5].map((v) => `<option value="${v}" ${String((st[k] || {})[p.id] ?? "") === String(v) ? "selected" : ""}>${v === "" ? "U" : v}</option>`).join("")}</select>`;
    h += `<div class="cm-g"><span class="gl ${g === "U" ? "u" : "g" + g}">${k}<b>${gtxt(g)}</b></span><div><b>${NAMES[k]} · weight ${W[k]}</b><span>${esc(e.reasons[k])}</span>${ctl ? `<div class="cm-ctl">${ctl}</div>` : ""}</div></div>`;
  }
  h += `<div class="cm-summary"><span>Coverage ${e.coverage}/100</span><span>Confidence <b>${e.conf}</b></span><span>Score is evidence, not probability</span></div></div>`;
  // matchup map
  h += `<div class="section-title"><h2>Direct opponent map</h2><span class="aside">tap who he'll face most</span></div><div class="card cm-opp">`;
  if (!opp.length) h += `<p class="muted small">No opponent stat lines loaded yet.</p>`;
  for (const o of opp.slice(0, 14)) h += `<button class="cm-o ${myOpps.includes(o.id) ? "on" : ""}" data-action="cmOpp" data-pid="${esc(p.id)}" data-oid="${esc(o.id)}"><span class="pos">${POS[o.pos] || "?"}</span><span>${esc(o.name)}<small>${esc(cmStatus(X.id, o.side, o.id).txt)}</small></span><b>${f2(o.fw90)}</b><em>FW/90</em></button>`;
  h += `<div class="dim small" style="padding-top:6px">Confirm the actual channel — inverted wingers, overlaps and rotation change the map. A player who draws fouls isn't himself a booking candidate.</div></div>`;
  // case + eye test
  const ws = (st.why || {})[p.id] || {};
  const autoExp = `${p.fc90 !== null ? `${f2(p.fc90)} fouls/90` : "Foul rate unknown"}${p.all.cardN ? `, booked in ${p.all.booked} of ${p.all.cardN} comparable games` : ""}${myOpps.length ? `, likely up against ${opp.filter((o) => myOpps.includes(o.id)).map((o) => o.name).join(" / ")}` : ""}.`;
  h += `<div class="section-title"><h2>The case</h2><span class="aside">both lines are required</span></div><div class="card cm-why">
    <label>He is exposed to a booking because…<textarea data-cm="exp" data-pid="${esc(p.id)}" placeholder="${esc(autoExp)}">${esc(ws.exp || "")}</textarea></label>
    <label>The strongest reason this case might fail is…<textarea data-cm="fail" data-pid="${esc(p.id)}" placeholder="e.g. expected minutes, protective cover, lenient referee, early-yellow restraint">${esc(ws.fail || "")}</textarea></label>
    <label>Your eye-test observation (USER-OBSERVED — match, date, what you saw)<textarea data-cm="obs" data-pid="${esc(p.id)}" placeholder="Specific behaviour: late timing, recovery fouls, dissent, aerial challenges…">${esc(ws.obs || "")}</textarea></label></div>`;
  // prices
  const books = (st.prices && st.prices[p.id]) || [];
  h += `<div class="section-title"><h2>Prices — to be carded</h2><span class="aside">scan every book you have</span></div><div class="card cm-price">`;
  books.forEach((b, i) => { h += `<div class="cm-bk"><b>${esc(b.b)}</b><span>${oddsTxt(parseOdds(b.o))}</span><em>${fmtDay(b.at)} ${fmtTime(b.at)}</em><button data-action="cmDelPrice" data-pid="${esc(p.id)}" data-i="${i}" aria-label="Remove">✕</button></div>`; });
  h += `<div class="cm-add"><input list="cmBooks" id="cmBook" placeholder="Bookmaker"><datalist id="cmBooks">${CM_BOOKS.map((b) => `<option value="${b}">`).join("")}</datalist><input id="cmOdds" placeholder="e.g. 7/2 or 4.5" inputmode="decimal"><button class="btn primary" data-action="cmAddPrice" data-pid="${esc(p.id)}">Add</button></div>`;
  if (e.books.length) {
    h += `<div class="cm-verdict">${vchip(e.verdict)}<p>${esc(e.verdict[1])}</p>
      <div class="cm-nums"><span>Best <b>${oddsTxt(e.best.d)}</b> ${esc(e.best.b)}</span><span>Break-even <b>${pc(e.breakEven, 1)}</b></span><span>Range <b>${e.range ? `${pc(e.range[0])}–${pc(e.range[1])}` : "n/a"}</b></span><span>EV <b>${e.ev ? `${evTxt(e.ev[0])} to ${evTxt(e.ev[1])}` : "n/a"}</b></span><span>Min odds <b>${oddsTxt(e.minOdds)}</b></span>${e.gap !== null ? `<span>Gap <b>${e.gap.toFixed(0)}%</b> ${esc(e.flag)}</span>` : ""}</div></div>`;
  } else h += `<p class="muted small">No prices yet — the football assessment above stays price-independent. Add every bookmaker you can see; the best price is used and the gap between books is flagged.</p>`;
  h += `<div class="dim small">Check the bookmaker's rules: non-starter voids, reds, bench cards, extra time and Super Sub terms. Singles floor ${oddsTxt(s.single)} — a below-floor winner is still a correct exclusion.</div></div>`;
  // fouls companion
  const fp = (st.foul && st.foul[p.id]) || {};
  h += `<div class="section-title"><h2>Fouls companion</h2><span class="aside">different route, not a hedge</span></div><div class="card cm-tab">`;
  h += `<div class="cm-row hd"><span>Line</span><span>Hit · range</span><span>Price → verdict</span></div>`;
  for (const k of [1, 2, 3]) {
    const hits = p.all["fc" + k], n = p.all.fcN, r = n >= CM_MIN_N ? wilson(hits, n) : null, d = parseOdds(fp[k]);
    let v = "";
    if (d && r) { const lo = r[0] * d - 1, hi = r[1] * d - 1; v = lo > 0 ? "BET" : hi < 0 ? "PASS" : "WATCH"; }
    h += `<div class="cm-row"><span>${k}+ fouls</span><b>${n ? `${hits}/${n}` : "–"}<small>${r ? `${pc(r[0])}–${pc(r[1])}` : "not estimable"}</small></b><em><input class="cm-fo" data-cm="foul" data-k="${k}" data-pid="${esc(p.id)}" value="${esc(fp[k] || "")}" placeholder="odds" inputmode="decimal">${v ? ` <span class="vchip v-${v.toLowerCase()}">${v}</span>` : d ? ` <span class="dim">BE ${pc(1 / d)}</span>` : ""}</em></div>`;
  }
  h += `<div class="dim small" style="padding-top:6px">No singles floor on fouls. Booking confidence doesn't carry across to 2+/3+ fouls; an early yellow can mean restraint or a substitution.</div></div>`;
  app().innerHTML = h;
}

// ---------- slate ----------
async function viewSlate() {
  setNav("home");
  app().innerHTML = `<a class="back" href="#/">${ICON.back} Home</a>${skeleton(1, 120)}${skeleton(4, 80)}`;
  try { await loadComps(); } catch {}
  const [d] = await Promise.all([loadBrief(false), cmTables(false)]);
  if (S.route !== "slate") return;
  const s = cmSettings();
  let h = `<a class="back" href="#/">${ICON.back} Home</a><div class="card hero cm-hero"><div class="kicker-s">Yellow Card Method · slate triage</div><h1 style="font-size:26px">Card Method</h1>
    <p>Research priority for every fixture in the Daily Brief — referee and both teams' own/opponent cards. Ratings decide where to look, never what to bet.</p>
    <div class="cm-tags"><span class="tag">Ref reference ${f2(s.ref)}</span><span class="tag">Singles ${oddsTxt(s.single)}</span><span class="tag">Doubles ${oddsTxt(s.double)}</span><a class="tag link" href="#/cardlog">Card log →</a></div></div>`;
  if (!CM.tables) h += `<div class="card note small"><b>Card tables aren't on GitHub yet.</b> Run GitHub → Actions → Daily Brief → Run workflow. The first run fills referee records over a few mornings.</div>`;
  if (!d || !d.fixtures.length) { app().innerHTML = h + `<div class="card empty"><h3>No fixtures in the Daily Brief</h3><p>Open the Daily Brief first, or wait for the morning run.</p></div>`; return; }
  const days = {};
  for (const f of d.fixtures) (days[fmtDay(f.time)] ||= []).push(f);
  const order = { PRIORITY: 0, RESERVE: 1, DEPRIORITISED: 2 };
  for (const [day, list] of Object.entries(days)) {
    const busy = list.length > 4;
    const rows = list.map((f) => ({ f, t: cmTriage({ code: f.comp, referee: f.referee, home: f.home, away: f.away, busy }), mine: Object.keys(fxState(f.id).picks || {}).length }))
      .sort((a, b) => order[a.t.rating] - order[b.t.rating] || Date.parse(a.f.time) - Date.parse(b.f.time));
    h += `<div class="section-title"><h2>${esc(day)}</h2><span class="aside">${list.length} fixtures · ${busy ? "BUSY — detail work on 4–5" : "SMALL — assess all"}</span></div>`;
    for (const { f, t, mine } of rows) {
      const own = (T0) => (T0 ? `${f2(T0.own / T0.n)} / ${f2(T0.opp / T0.n)}` : "– / –");
      h += `<a class="card cm-slate" href="#/method/${esc(f.comp)}/${esc(f.id)}"><div class="bt-fx">${crest(f.home)}${crest(f.away)}<span>${esc(f.home.name)} v ${esc(f.away.name)}</span><em>${kickoff(f.time)} · ${esc(compShort(f.comp))}</em></div>
        <div class="cm-slate-g"><div><span>Referee</span><b>${t.R && t.R.n ? f2(t.R.ycpg) : "?"}</b><em>${f.referee ? esc(f.referee.split(" ").slice(-1)[0]) + " · n " + (t.R ? t.R.n : 0) : "not listed"}</em></div>
          <div><span>Home own/opp</span><b>${own(t.H)}</b><em>n ${t.H ? t.H.n : 0}</em></div><div><span>Away own/opp</span><b>${own(t.A)}</b><em>n ${t.A ? t.A.n : 0}</em></div><div><span>League</span><b>${t.C ? f2(t.C.ycpg) : "–"}</b><em>YC/game</em></div></div>
        <div class="cm-tags">${ratingChip(t.rating)}<span class="tag">${t.conf}</span>${mine ? `<span class="tag star">★ ${mine} of your names — exception review</span>` : ""}</div><p class="cm-reason">${esc(t.reason || "")}</p></a>`;
    }
  }
  h += `<div class="note card small">"Own" = cards the team receives; "opp" = cards its opponents receive. Pairs are compared, never summed. Unknown referees stay UNRESOLVED, never treated as low. 18+ · BeGambleAware.org</div>`;
  app().innerHTML = h;
}

// ---------- log, audit, doubles, settings ----------
function cmFreeze() {
  const X = CM.ctx; if (!X) return;
  const st = fxState(X.id), s = cmSettings();
  const cands = [];
  for (const side of ["home", "away"]) for (const p of X.players[side]) {
    if (p.pos === 0) continue;
    const e = cmEval(p, X), mine = !!(st.picks && st.picks[p.id]);
    if (!mine && !(e.coverage >= 45 && (e.score ?? 0) >= 50) && !e.books.length) continue;
    cands.push({ pid: p.id, name: p.name, team: p.team.name, side, status: X.status(p).txt, origin: mine ? "USER" : "ANALYST", grades: e.grades, score: e.score, coverage: e.coverage, conf: e.conf,
      booked: p.all.booked, n: p.all.cardN, range: e.range, fc90: p.fc90, best: e.best ? { b: e.best.b, d: e.best.d } : null, books: e.books.map((b) => ({ b: b.b, d: b.d, at: b.at })), gap: e.gap,
      verdict: e.verdict || ["WATCH", "No price entered."], why: (st.why || {})[p.id] || null, role: (st.role || {})[p.id] || null });
  }
  cands.sort((a, b) => (b.score ?? -1) * b.coverage - (a.score ?? -1) * a.coverage);
  const f = X.A.fixture;
  const entry = { id: "e" + Date.now().toString(36), at: new Date().toISOString(), method: "Johnny Poker YC v1.5 (app)", fx: { comp: X.comp, id: X.id, home: X.A.home.team.name, away: X.A.away.team.name, time: f.time, referee: f.referee || null },
    triage: { rating: X.tri.rating, conf: X.tri.conf, reason: X.tri.reason, ref: X.tri.R && X.tri.R.n ? [X.tri.R.ycpg, X.tri.R.n] : null, bench: X.tri.C ? X.tri.C.ycpg : null },
    slate: X.busy ? "BUSY" : "SMALL", exposure: Object.values(st.prices || {}).some((l) => l && l.length) ? "MARKET-AWARE" : "INDEPENDENT", settings: s,
    weather: st.weather || null, preview: !!st.preview, lineup: (PL.lineups.get(X.id) && PL.lineups.get(X.id).home && PL.lineups.get(X.id).home.confirmed) ? "confirmed" : "predicted/unknown", cands };
  const log = store.get("cmLog", []); log.push(entry);
  while (log.length > 150) log.shift();
  store.set("cmLog", log);
  toast(`Frozen · ${cands.length} player${cands.length === 1 ? "" : "s"} recorded`);
  location.hash = "#/cardlog";
}

async function cmAudit(eid) {
  const log = store.get("cmLog", []), e = log.find((x) => x.id === eid); if (!e) return;
  toast("Checking the result…");
  try {
    const pd = await api("players?id=" + e.fx.id);
    if (pd.status !== "finished") { toast("Match not finished yet"); return; }
    const res = {};
    for (const c of e.cands) {
      const p = pd.players.find((x) => String(x.id) === String(c.pid));
      res[c.pid] = p ? { played: true, min: p.s.min ?? null, yc: pd.cardsOk ? (p.s.yc ?? 0) : null, rc: pd.cardsOk ? (p.s.rc ?? 0) : null, fc: p.s.fouls ?? null } : { played: false };
    }
    const au = store.get("cmAudit", {}); au[eid] = { at: new Date().toISOString(), cardsOk: pd.cardsOk, res }; store.set("cmAudit", au);
  } catch (err) { toast("Couldn't load the result: " + err.message); return; }
  viewCardLog();
}

function cmExport() {
  const log = store.get("cmLog", []), au = store.get("cmAudit", {}), bets = store.get("cmBets", {}), ch = store.get("cmChanges", []);
  const L = ["DAYLEESTATCARDZ — YELLOW CARD METHOD LOG", `Exported ${new Date().toISOString()}`, ""];
  for (const e of log) {
    L.push(`== ${e.fx.home} v ${e.fx.away} · ${e.fx.time} · ${e.fx.comp}`, `Frozen ${e.at} · ${e.method} · ${e.slate} slate · ${e.exposure} · triage ${e.triage.rating} (${e.triage.conf}) · ref ${e.fx.referee || "UNKNOWN"} ${e.triage.ref ? f2(e.triage.ref[0]) + " YC/g n " + e.triage.ref[1] : "UNRESOLVED"} · weather ${e.weather ? e.weather.s : "NOT RECORDED"} · line-up ${e.lineup}`);
    for (const c of e.cands) {
      const a = au[e.id] && au[e.id].res[c.pid], b = bets[e.id + ":" + c.pid];
      L.push(`  ${c.name} (${c.team}, ${c.origin}) — ${c.verdict[0]}${c.verdict[2] ? " " + c.verdict[2] : ""}: ${c.verdict[1]} | grades ${Object.entries(c.grades).map(([k, g]) => k + g).join(" ")} points ${c.coverage ? ((c.score * c.coverage) / 100).toFixed(1) : "–"} of ${c.coverage} assessed ${c.conf} | booked ${c.booked}/${c.n} range ${c.range ? pc(c.range[0]) + "–" + pc(c.range[1]) : "n/a"} | best ${c.best ? c.best.b + " " + oddsTxt(c.best.d) : "no price"}`
        + (a ? ` || RESULT: ${a.played ? `${a.min ?? "?"}' · ${a.yc === null ? "card data unavailable" : a.yc > 0 ? "BOOKED" : "not booked"}${a.rc ? " · RED" : ""} · ${a.fc ?? "?"} fouls` : "did not play"}` : " || RESULT: not audited")
        + (b ? ` || BET: stake ${b.stake} @ ${oddsTxt(b.d)} ${b.book || ""}` : ""));
      if (c.why && (c.why.exp || c.why.fail || c.why.obs)) L.push(`     exposed because: ${c.why.exp || "–"} | might fail: ${c.why.fail || "–"} | eye test: ${c.why.obs || "–"}`);
    }
    L.push("");
  }
  if (ch.length) { L.push("CHANGE LOG"); for (const c of ch) L.push(`${c.at} · ${c.field}: ${c.from} → ${c.to}`); }
  return L.join("\n");
}

function viewCardLog() {
  setNav("home");
  const log = store.get("cmLog", []).slice().reverse(), au = store.get("cmAudit", {}), bets = store.get("cmBets", {}), s = cmSettings();
  let h = `<a class="back" href="#/slate">${ICON.back} Card Method</a><div class="card hero cm-hero"><div class="kicker-s">Decision trail · never rewritten</div><h1 style="font-size:26px">Card log</h1>
    <p>${log.length} frozen assessment${log.length === 1 ? "" : "s"}. Audit every shortlisted player after the match — backed or not.</p></div>`;
  // doubles
  const legs = [];
  for (const e of log) for (const c of e.cands) if (Date.parse(e.fx.time) > Date.now() - 3 * 3600e3) legs.push({ e, c });
  const dsel = store.get("cmDouble", { a: "", b: "", o: "" });
  if (legs.length >= 2) {
    const opt = (v) => legs.map(({ e, c }) => `<option value="${e.id}:${esc(c.pid)}" ${v === e.id + ":" + c.pid ? "selected" : ""}>${esc(c.name)} — ${esc(e.fx.home)} v ${esc(e.fx.away)} (${c.verdict[0]})</option>`).join("");
    h += `<div class="section-title"><h2>Double check</h2><span class="aside">floor ${oddsTxt(s.double)}</span></div><div class="card cm-dbl">
      <select data-cm="dblA"><option value="">Leg 1…</option>${opt(dsel.a)}</select><select data-cm="dblB"><option value="">Leg 2…</option>${opt(dsel.b)}</select>
      <input data-cm="dblO" value="${esc(dsel.o)}" placeholder="Offered double price, e.g. 14/1" inputmode="decimal"><div id="cmDblOut">${cmDouble(legs, dsel, s)}</div></div>`;
  }
  if (!log.length) h += `<div class="card empty"><h3>Nothing frozen yet</h3><p>Open a fixture → Cards tab → Yellow Card Method, then "Freeze this assessment".</p></div>`;
  for (const e of log) {
    const a = au[e.id], done = Date.parse(e.fx.time) + 2.5 * 3600e3 < Date.now();
    h += `<div class="card cm-log"><div class="cm-log-h"><b>${esc(e.fx.home)} v ${esc(e.fx.away)}</b><span>${kickoff(e.fx.time)} · frozen ${fmtDay(e.at)} ${fmtTime(e.at)} · ${e.exposure}</span><span>${ratingChip(e.triage.rating)} ${e.slate} · ref ${e.triage.ref ? f2(e.triage.ref[0]) : "?"} · weather ${e.weather ? e.weather.s : "not recorded"}</span></div>`;
    if (!e.cands.length) h += `<p class="muted small">No candidate qualified — a valid result.</p>`;
    for (const c of e.cands) {
      const r = a && a.res[c.pid], b = bets[e.id + ":" + c.pid];
      const out = r ? (r.played ? (r.yc === null ? "card data n/a" : r.yc > 0 ? "🟨 BOOKED" : "not booked") + ` · ${r.min ?? "?"}' · ${r.fc ?? "?"} fouls` : "didn't play") : "";
      h += `<div class="cm-lc"><div><b>${esc(c.name)}</b><span>${esc(c.team)} · ${c.origin} · ${c.best ? oddsTxt(c.best.d) + " " + esc(c.best.b) : "no price"} · range ${c.range ? `${pc(c.range[0])}–${pc(c.range[1])}` : "n/a"}</span>${out ? `<span class="${/BOOKED/.test(out) ? "ok-t" : ""}">${out}</span>` : ""}${b ? `<span>Bet: £${esc(String(b.stake))} @ ${oddsTxt(b.d)}${r && r.played && r.yc !== null ? ` → ${r.yc > 0 ? `return £${(b.stake * b.d).toFixed(2)}` : "lost"}` : ""}</span>` : ""}</div>${vchip(c.verdict)}
        <button class="cm-mini" data-action="cmBet" data-k="${e.id}:${esc(c.pid)}">${b ? "Edit bet" : "I bet this"}</button></div>`;
      if (CM.betOpen === e.id + ":" + c.pid) h += `<div class="cm-betf"><input name="stake" placeholder="Stake £" inputmode="decimal" value="${b ? b.stake : ""}"><input name="odds" placeholder="Odds taken" value="${b ? esc(b.o) : esc(c.best ? fracOf(c.best.d) || c.best.d.toFixed(2) : "")}"><input name="book" placeholder="Bookmaker" value="${b ? esc(b.book) : esc(c.best ? c.best.b : "")}"><button class="btn primary" data-action="cmBetSave" data-k="${e.id}:${esc(c.pid)}">Save</button>${b ? `<button class="btn" data-action="cmBetDel" data-k="${e.id}:${esc(c.pid)}">Remove</button>` : ""}</div>`;
    }
    h += `<div class="cm-log-a">${done ? `<button class="btn" data-action="cmAudit" data-e="${e.id}">${a ? "Re-check result" : "Audit result"}</button>` : `<span class="dim small">Audit opens after the match</span>`}<a class="btn" href="#/method/${esc(e.fx.comp)}/${esc(e.fx.id)}">Re-open</a></div></div>`;
  }
  // settings
  h += `<div class="section-title"><h2>Your preferences</h2><span class="aside">every change is logged</span></div><div class="card cm-set">
    <label>Singles floor (decimal)<input data-cm="set" data-k="single" value="${s.single}" inputmode="decimal"></label>
    <label>Doubles floor (decimal)<input data-cm="set" data-k="double" value="${s.double}" inputmode="decimal"></label>
    <label>Referee caution reference (YC/game)<input data-cm="set" data-k="ref" value="${s.ref}" inputmode="decimal"></label>
    <span class="dim small">Johnny Poker defaults: 3/1 (4.00), 12/1 (13.00), 4.0. Preferences, not proof of value.</span></div>`;
  h += `<div class="cm-actions"><button class="btn primary" data-action="cmExport">Copy whole log as text</button></div><textarea id="cmExportBox" class="cm-export" readonly hidden></textarea>`;
  app().innerHTML = h;
}

function cmDouble(legs, sel, s) {
  const A = legs.find((l) => l.e.id + ":" + l.c.pid === sel.a), B = legs.find((l) => l.e.id + ":" + l.c.pid === sel.b), d = parseOdds(sel.o);
  if (!A || !B) return `<p class="dim small">Pick two legs from your frozen assessments.</p>`;
  if (A === B) return `<p class="dim small">Pick two different players.</p>`;
  const same = A.e.fx.id === B.e.fx.id;
  const lines = [];
  const legOk = (l) => l.c.verdict[0] === "BET";
  lines.push(`${esc(A.c.name)}: ${A.c.verdict[0]} · ${esc(B.c.name)}: ${B.c.verdict[0]}${legOk(A) && legOk(B) ? "" : " — each leg needs its own supported case."}`);
  let v = "WATCH", why = "";
  if (!d) why = "Enter the actual offered double price.";
  else if (d < s.double) { v = "PASS"; why = `${oddsTxt(d)} is below your ${oddsTxt(s.double)} doubles floor.`; }
  else if (same) why = "Same match: referee, game state and incidents link the legs — joint value can't be supported without evidence of dependence.";
  else if (!A.c.range || !B.c.range) why = "A leg has no estimable range.";
  else {
    const lo = A.c.range[0] * B.c.range[0], hi = A.c.range[1] * B.c.range[1];
    lines.push(`Independence benchmark (sensitivity only): ${pc(lo, 1)}–${pc(hi, 1)} v break-even ${pc(1 / d, 1)} · EV ${evTxt(lo * d - 1)} to ${evTxt(hi * d - 1)}`);
    if (legOk(A) && legOk(B) && lo * d - 1 > 0) { v = "BET"; why = "Both legs qualify and the benchmark is positive at the low end."; }
    else if (hi * d - 1 < 0) { v = "PASS"; why = "Even the benchmark's top end is under break-even."; }
    else why = "Range spans break-even, or a leg doesn't qualify on its own.";
  }
  return `<div class="cm-verdict">${vchip([v])}<p>${esc(why)}</p>${lines.map((l) => `<p class="dim small">${l}</p>`).join("")}</div>`;
}

// ---------- events ----------
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-action]"); if (!b) return;
  const a = b.dataset.action, X = CM.ctx;
  const rerender = () => { if (S.route === "method" && X) { const pid = location.hash.split("/")[4]; pid ? renderCandidate(X, decodeURIComponent(pid)) : renderMethod(X); } };
  if (a === "cmWeather" && X) { fxSave(X.id, (s) => { s.weather = { s: b.dataset.w, at: new Date().toISOString() }; }); rerender(); }
  else if (a === "cmPreview" && X) { fxSave(X.id, (s) => { s.preview = s.preview ? null : { at: new Date().toISOString() }; }); rerender(); }
  else if (a === "cmPick" && X) { fxSave(X.id, (s) => { s.picks ||= {}; if (s.picks[b.dataset.pid]) delete s.picks[b.dataset.pid]; else s.picks[b.dataset.pid] = { at: new Date().toISOString() }; }); rerender(); }
  else if (a === "cmOpp" && X) { fxSave(X.id, (s) => { s.opps ||= {}; const l = (s.opps[b.dataset.pid] ||= []); const i = l.indexOf(b.dataset.oid); i >= 0 ? l.splice(i, 1) : l.push(b.dataset.oid); }); rerender(); }
  else if (a === "cmAddPrice" && X) {
    const book = ($("#cmBook").value || "").trim(), o = ($("#cmOdds").value || "").trim();
    if (!book || !parseOdds(o)) { toast("Enter a bookmaker and odds like 7/2 or 4.5"); return; }
    fxSave(X.id, (s) => { s.prices ||= {}; (s.prices[b.dataset.pid] ||= []).push({ b: book, o, at: new Date().toISOString() }); }); rerender();
  } else if (a === "cmDelPrice" && X) { fxSave(X.id, (s) => { (s.prices[b.dataset.pid] || []).splice(+b.dataset.i, 1); }); rerender(); }
  else if (a === "cmFreeze") cmFreeze();
  else if (a === "cmAudit") cmAudit(b.dataset.e);
  else if (a === "cmBet") { CM.betOpen = CM.betOpen === b.dataset.k ? null : b.dataset.k; viewCardLog(); }
  else if (a === "cmBetSave" || a === "cmBetDel") {
    const bets = store.get("cmBets", {}), k = b.dataset.k, box = b.closest(".cm-betf");
    if (a === "cmBetDel") delete bets[k];
    else {
      const stake = parseFloat(box.querySelector("[name=stake]").value), o = box.querySelector("[name=odds]").value.trim(), book = box.querySelector("[name=book]").value.trim();
      if (!(stake > 0) || !parseOdds(o)) { toast("Enter a stake and odds like 4/1"); return; }
      bets[k] = { stake, o, d: parseOdds(o), book, at: new Date().toISOString() };
    }
    store.set("cmBets", bets); CM.betOpen = null; viewCardLog();
  } else if (a === "cmExport") {
    const t = cmExport(), box = $("#cmExportBox");
    box.hidden = false; box.value = t; box.focus(); box.select();
    try { navigator.clipboard.writeText(t).then(() => toast("Log copied"), () => toast("Select all and copy the text below")); } catch { toast("Select all and copy the text below"); }
  }
});
document.addEventListener("change", (ev) => {
  const el = ev.target.closest("[data-cm]"); if (!el) return;
  const k = el.dataset.cm, X = CM.ctx;
  if ((k === "D" || k === "F" || k === "role") && X) { fxSave(X.id, (s) => { s[k] ||= {}; s[k][el.dataset.pid] = el.value; }); renderCandidate(X, el.dataset.pid); }
  else if ((k === "exp" || k === "fail" || k === "obs") && X) fxSave(X.id, (s) => { s.why ||= {}; (s.why[el.dataset.pid] ||= {})[k] = el.value; });
  else if (k === "foul" && X) { fxSave(X.id, (s) => { s.foul ||= {}; (s.foul[el.dataset.pid] ||= {})[el.dataset.k] = el.value; }); renderCandidate(X, el.dataset.pid); }
  else if (k === "set") { const v = parseFloat(el.value); if (v > 1) { cmChange(el.dataset.k, v); toast("Saved · change logged"); } viewCardLog(); }
  else if (k === "dblA" || k === "dblB" || k === "dblO") {
    const d = store.get("cmDouble", { a: "", b: "", o: "" }); d[{ dblA: "a", dblB: "b", dblO: "o" }[k]] = el.value; store.set("cmDouble", d);
    const legs = []; for (const e of store.get("cmLog", [])) for (const c of e.cands) if (Date.parse(e.fx.time) > Date.now() - 3 * 3600e3) legs.push({ e, c });
    $("#cmDblOut").innerHTML = cmDouble(legs, d, cmSettings());
  }
});
