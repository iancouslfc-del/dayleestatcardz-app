/* =====================================================================
   DayleeStatCardz — player bets
   Every player line is built from the provider's per-match player stat
   lines (/v1/matches/{id}/players) for the same team samples the rest of
   the app uses. Nothing is estimated. Appearances under 45 minutes are
   left out, exactly as the card says.
   ===================================================================== */
"use strict";

const PROP_DEFS = [
  { stat: "shots",   name: "Shots",           chip: "shots",   lines: [0.5, 1.5, 2.5, 3.5] },
  { stat: "sot",     name: "Shots on target", short: "SoT", chip: "sot", lines: [0.5, 1.5, 2.5] },
  { stat: "tackles", name: "Tackles",         chip: "tackles", lines: [0.5, 1.5, 2.5, 3.5] },
  { stat: "fouls",   name: "Fouls committed", short: "Fouls", chip: "fouls", lines: [0.5, 1.5, 2.5] },
  { stat: "fouled",  name: "Times fouled",    short: "Times fouled", chip: "fouled", lines: [0.5, 1.5, 2.5, 3.5] },
  { stat: "goals",   name: "Goals",           chip: "goals",   lines: [0.5, 1.5] },
  { stat: "ga",      name: "Goal or assist",  chip: "goals",   lines: [0.5] },
  { stat: "assists", name: "Assists",         chip: "assists", lines: [0.5] },
  { stat: "cards",   name: "Cards",           chip: "cards",   lines: [0.5] },
  { stat: "saves",   name: "Saves",           chip: "saves",   lines: [0.5, 1.5, 2.5, 3.5, 4.5] },
];
const PL_CHIPS = [["best", "★ Best"], ["shots", "Shots"], ["sot", "On target"], ["tackles", "Tackles"], ["fouls", "Fouls"], ["fouled", "Fouled"], ["goals", "Goals"], ["assists", "Assists"], ["cards", "Cards"], ["saves", "Saves"]];
const PL_MIN_MIN = 45, PL_MIN_N = 5, PL_SMALL_N = 3, PL_MIN_RATE = 70, PL_SCAN_DAYS = 7, PL_SCAN_MAX = 10;
const POS = { 0: "G", 1: "D", 2: "M", 3: "A" };

const PL = {
  data: new Map(),       // match id -> player lines
  err: new Map(),
  lineups: new Map(),    // fixture id -> lineups | null
  loading: { total: 0, done: 0 },
  filter: null, mode: null, team: "both",
  rendered: new Map(),   // prop key -> prop (for the ☆ button)
  scans: {},             // comp|mode -> scan state
  timer: null,
};
function plInit() {
  if (PL.filter) return;
  PL.filter = store.get("plFilter", "best");
  PL.mode = store.get("plMode", "venue");
  S.favProps = store.get("favProps", {});
}

// ---------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------
async function plLoad(ids, onProgress) {
  const todo = [...new Set(ids)].filter((id) => !PL.data.has(id));
  if (!todo.length) return;
  PL.loading = { total: todo.length, done: 0 };
  onProgress && onProgress();
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try { PL.data.set(id, await api("players?id=" + id)); PL.err.delete(id); }
      catch (e) { PL.err.set(id, e.message); }
      PL.loading.done++;
      onProgress && onProgress();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
async function plLineups(id) {
  if (PL.lineups.has(id)) return PL.lineups.get(id);
  let lu = null;
  try { lu = await api("lineups?id=" + id); } catch { lu = null; }
  PL.lineups.set(id, lu);
  return lu;
}
// Player stats use THIS SEASON only (matches from the current season in this competition).
const plSample = (A, key, mode) => (mode === "all" ? A[key].allSample || A[key].sample : A[key].sample).filter((m) => m.cur);
const seasonShort = (s) => { const m = String(s || "").match(/^(\d{4})\/(\d{4})$/); return m ? m[1].slice(2) + "/" + m[2].slice(2) : String(s || "this season"); };
function plIds(A, mode) { return [...plSample(A, "home", mode), ...plSample(A, "away", mode)].map((m) => m.id); }

// ---------------------------------------------------------------------
// Building player lines
// ---------------------------------------------------------------------
const tName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
function propLabel(def, line, tackleLabel) {
  const k = line + 0.5;
  if (def.stat === "goals") return line === 0.5 ? "Anytime goalscorer" : `${k}+ Goals`;
  if (def.stat === "assists") return "1+ Assist";
  if (def.stat === "ga") return "Goal or assist";
  if (def.stat === "cards") return "To be carded";
  if (def.stat === "tackles" && tackleLabel) return `${k}+ ${tackleLabel}`;
  return `${k}+ ${def.short || def.name}`;
}
function valueOf(def, app) {
  const s = app.s;
  if (def.stat === "ga") return s.goals === null || s.goals === undefined || s.assists === null || s.assists === undefined ? null : s.goals + s.assists;
  if (def.stat === "cards") return app.cardsOk ? (s.cards ?? null) : null;
  const v = s[def.stat];
  return v === undefined ? null : v;
}

// Returns every qualifying prop for one fixture analysis.
function buildPlayerProps(A, mode, opts = {}) {
  const out = [];
  const lu = PL.lineups.get(A.fixture.id) || null;
  for (const key of ["home", "away"]) {
    if (opts.team && opts.team !== "both" && opts.team !== key) continue;
    const side = A[key], team = side.team;
    const matches = plSample(A, key, mode);
    const players = new Map();
    let loaded = 0;
    for (const m of matches) {
      const pd = PL.data.get(m.id); if (!pd) continue;
      loaded++;
      const isHome = m.home.id === team.id || tName(m.home.name) === tName(team.name);
      const tId = isHome ? pd.homeId : pd.awayId;
      const opp = isHome ? m.away : m.home;
      for (const p of pd.players) {
        if (!p.t || p.t !== tId) continue;
        let rec = players.get(p.id);
        if (!rec) { rec = { id: p.id, name: p.n, img: p.img, pos: p.pos, apps: [] }; players.set(p.id, rec); }
        if (!rec.img && p.img) rec.img = p.img;
        rec.apps.push({ m, opp, isHome, min: p.s.min, s: p.s, zf: p.zf || [], cardsOk: pd.cardsOk, lbl: p.lbl || {} });
      }
    }
    const desc = (mode === "all" ? `${team.name} all games` : `${team.name} ${key} games`) + ` · ${seasonShort(A.season)}`;
    for (const rec of players.values()) {
      const games = rec.apps.filter((a) => a.min === null || a.min === undefined || a.min >= PL_MIN_MIN);
      if (games.length < PL_SMALL_N) continue;
      const isGK = games.some((a) => a.s.saves !== null && a.s.saves !== undefined) || rec.pos === 0;
      const tackleLabel = games.filter((a) => a.lbl.tackles).length > games.length / 2 ? "Tackles won" : null;
      for (const def of PROP_DEFS) {
        if (opts.chip && opts.chip !== "best" && def.chip !== opts.chip) continue;
        if (def.stat === "saves" && !isGK) continue;
        if (isGK && def.stat !== "saves" && def.stat !== "cards") continue;
        const rows = games.map((a) => ({ a, v: valueOf(def, a) }));
        const valid = rows.filter((r) => r.v !== null);
        const n = valid.length;
        if (n < PL_SMALL_N) continue;
        for (const line of [...def.lines].reverse()) {
          const hits = valid.filter((r) => r.v > line).length;
          const pct = (100 * hits) / n;
          if (pct < PL_MIN_RATE) continue;
          let streak = 0; for (const r of valid) { if (r.v > line) streak++; else break; }
          let status = null;
          if (lu && lu[key]) {
            const L = lu[key];
            if (L.starters.includes(rec.id)) status = L.confirmed ? "Confirmed starter" : "Predicted starter";
            else if (L.subs.includes(rec.id)) status = L.confirmed ? "On the bench" : "Predicted bench";
            else if (L.confirmed) status = "Not in squad";
          }
          out.push({
            key: `${A.fixture.id}|${rec.id}|${def.stat}|${line}|${mode}`, comp: A.competition.code,
            fixture: { id: A.fixture.id, time: A.fixture.time, home: { name: A.fixture.home.name, img: A.fixture.home.img }, away: { name: A.fixture.away.name, img: A.fixture.away.img } },
            player: { id: rec.id, name: rec.name, img: rec.img, pos: POS[rec.pos] || (isGK ? "G" : null) },
            team: { id: team.id, name: team.name, img: team.img }, side: key,
            stat: def.stat, line, label: propLabel(def, line, def.stat === "tackles" ? tackleLabel : null),
            hits, n, pct, streak, score: wilsonLB(hits, n), small: n < PL_MIN_N, mode, desc,
            played45: games.length, teamGames: loaded, status,
            rows: rows.map((r) => ({ v: r.v, hit: r.v === null ? null : r.v > line, min: r.a.min, zf: r.a.zf.includes(def.stat), opp: { name: r.a.opp.name, img: r.a.opp.img }, home: r.a.isHome, date: r.a.m.time, mid: r.a.m.id })),
          });
          break; // boldest line that still passes
        }
      }
    }
  }
  return out.sort((x, y) => (x.small - y.small) || (y.score - x.score) || (y.line - x.line));
}

// "Best" view: no more than two lines per player so one player can't fill the list.
function plFilterList(props, chip, limit) {
  if (chip !== "best") return props.slice(0, limit);
  const per = new Map(), res = [];
  for (const p of props) {
    const c = per.get(p.player.id) || 0; if (c >= 2) continue;
    per.set(p.player.id, c + 1); res.push(p);
    if (res.length >= limit) break;
  }
  return res;
}

// ---------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------
const shortDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: tz });
const kickoff = (iso) => {
  const d = new Date(iso);
  const day = fmtDay(iso);
  return (day === "Today" || day === "Tomorrow" ? day : d.toLocaleDateString("en-GB", { weekday: "short", timeZone: tz })) + " " + fmtTime(iso);
};
function playerPhoto(p, team) {
  const ini = esc(String(p.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase());
  const ph = p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;pc-ini&quot;>${ini}</span>'">` : `<span class="pc-ini">${ini}</span>`;
  return `<div class="pc-ph">${ph}<span class="pc-badge">${crest(team)}</span></div>`;
}
function strengthBar(score) {
  const on = Math.max(1, Math.round(score * 20));
  return `<span class="segs" aria-label="Trend strength ${on} of 20">${Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? "on" : ""}"></i>`).join("")}</span>`;
}
function propCard(p, opts = {}) {
  PL.rendered.set(p.key, p);
  const fav = !!(S.favProps && S.favProps[p.key]);
  const status = p.status || `45+ mins in ${p.played45} of ${p.teamGames}`;
  const statusCls = /Confirmed starter/.test(status) ? "ok" : /Not in squad|bench/i.test(status) ? "warn" : "";
  const anyZf = p.rows.some((r) => r.zf);
  return `<article class="pcard${p.small ? " small" : ""}">
    <div class="pc-fx">
      <button class="pc-fxlink" data-action="openFxPlayers" data-comp="${esc(p.comp)}" data-id="${esc(p.fixture.id)}">${crest(p.fixture.home)}${crest(p.fixture.away)}<span>${esc(p.fixture.home.name)} v ${esc(p.fixture.away.name)}</span></button>
      <span class="pc-ko">${kickoff(p.fixture.time)}</span>
      <button class="star ${fav ? "on" : ""}" data-action="favProp" data-key="${esc(p.key)}" aria-label="Save">${fav ? ICON.star : ICON.starO}</button>
    </div>
    <div class="pc-player">
      ${playerPhoto(p.player, p.team)}
      <div class="pc-who"><div class="pc-name"><b>${esc(p.player.name)}</b>${p.player.pos ? `<span class="pos">${p.player.pos}</span>` : ""}</div><div class="pc-team">${esc(p.team.name)}</div></div>
      <div class="pc-st"><span class="lbl">Status</span><b class="${statusCls}">${esc(status)}</b></div>
    </div>
    <div class="pc-prop">${esc(p.label)}</div>
    <div class="pc-row">
      <div><span class="lbl">Hit rate · ${esc(p.desc)}</span><div class="pc-big"><b style="color:${colorOf({ pct: p.pct, n: p.n })}">${Math.round(p.pct)}%</b><span>${p.hits} of ${p.n} games</span></div></div>
      <div class="r"><span class="lbl">Current streak</span><div class="pc-big"><b>${p.streak}</b><span>in a row</span></div></div>
    </div>
    <div class="pc-str"><span class="lbl">Trend strength</span>${strengthBar(p.score)}${p.small ? `<span class="warn-t small">Small sample</span>` : ""}</div>
    <div class="pc-hist">
      <div class="pc-hh"><span>Game history · ${PL_MIN_MIN}+ minutes · newest first</span><span class="lg"><i class="h"></i>Hit <i class="m"></i>Miss</span></div>
      <div class="hist-strip">${p.rows.map((r) => `<div class="hb">
        <div class="v ${r.hit === null ? "x" : r.hit ? "h" : "m"}${r.zf ? " zf" : ""}">${r.v === null ? "–" : r.v}</div>
        <div class="mn">${r.min === null || r.min === undefined ? "–" : r.min + "'"}</div>
        <div class="op">${crest(r.opp)}</div>
        <div class="dt">${shortDate(r.date)}</div>
        <div class="ha">${r.home ? "H" : "A"}</div></div>`).join("")}</div>
      ${anyZf ? `<div class="dim small" style="margin-top:6px">Dotted box = stat not listed by the provider for that game, counted as 0.</div>` : ""}
    </div>
  </article>`;
}

// ---------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------
function plChipRow(action) {
  plInit();
  return `<div class="pl-chips">${PL_CHIPS.map(([k, l]) => `<button class="${PL.filter === k ? "active" : ""}" data-action="${action}" data-chip="${k}">${l}</button>`).join("")}</div>`;
}
function plModeToggle(A) {
  const hn = A ? esc(A.home.team.name) : "Home team", an = A ? esc(A.away.team.name) : "Away team";
  return `<div class="pl-tog">
    <button class="${PL.mode === "venue" ? "active" : ""}" data-action="plMode" data-mode="venue"><b>Home / away rule</b><span>${A ? `${hn} home · ${an} away` : "home team at home · away team away"}</span></button>
    <button class="${PL.mode === "all" ? "active" : ""}" data-action="plMode" data-mode="all"><b>All games</b><span>this season, any venue</span></button></div>`;
}

// ---------------------------------------------------------------------
// Match page: Players tab
// ---------------------------------------------------------------------
function renderPlayersTab() {
  plInit();
  const A = S.analysis;
  const ids = plIds(A, PL.mode);
  const missing = ids.filter((id) => !PL.data.has(id) && !PL.err.has(id));
  if (missing.length && !PL.busy) {
    PL.busy = true;
    Promise.all([plLineups(A.fixture.id), plLoad(ids, plSchedule)]).finally(() => { PL.busy = false; plSchedule(); });
  }
  let html = "";
  const L = PL.loading;
  if (missing.length || (L.total && L.done < L.total)) html += `<div class="card progress">Loading player stats ${L.done}/${L.total || missing.length} matches — cards appear as each match arrives<div class="bar"><i style="width:${L.total ? (100 * L.done) / L.total : 0}%"></i></div></div>`;
  html += plModeToggle(A);
  html += `<div class="pl-team">${[["both", "Both teams"], ["home", A.home.team.name], ["away", A.away.team.name]].map(([k, l]) => `<button class="${PL.team === k ? "active" : ""}" data-action="plTeam" data-team="${k}">${k !== "both" ? crest(A[k].team) : ""}<span>${esc(l)}</span></button>`).join("")}</div>`;
  const props = buildPlayerProps(A, PL.mode, { chip: PL.filter, team: PL.team });
  const list = plFilterList(props, PL.filter, PL.filter === "best" ? 24 : 60);
  if (!list.length) {
    html += missing.length ? skeleton(2, 260) : `<div class="card empty">${ICON.ball}<h3>No player lines at ${PL_MIN_RATE}%+</h3><p>No player hit ${PL_MIN_RATE}%+ on this market in at least ${PL_SMALL_N} games of ${PL_MIN_MIN}+ minutes this season${PL.mode === "venue" ? ". Try “All games” for a bigger sample." : "."}</p></div>`;
  } else {
    html += `<div class="section-title"><h2>${PL.filter === "best" ? "Best player bets" : PL_CHIPS.find((c) => c[0] === PL.filter)[1]}</h2><span class="aside">${props.length} qualifying</span></div>`;
    html += list.map((p) => propCard(p)).join("");
  }
  html += plNote();
  return html;
}
function plSchedule() {
  if (PL.timer) return;
  PL.timer = setTimeout(() => {
    PL.timer = null;
    if (S.route === "match" && S.tab === "players") renderMatchBody();
    else if (S.route === "players") renderPlayersScreen();
  }, 300);
}
function plNote() {
  return `<div class="note card small"><b>How player lines work.</b><ul>
    <li><b>This season only:</b> player lines use matches from the current season in this competition — nothing from previous seasons.</li>
    <li><b>Home / away rule</b> (default): home-team players use their team's home games this season (up to the last 10), away-team players their away games. “All games” uses the last 10 this season at any venue.</li>
    <li>Only appearances of <b>${PL_MIN_MIN}+ minutes</b> count. A line shows when the player hit it in ${PL_MIN_RATE}%+ of those games (${PL_MIN_N}+ games, or ${PL_SMALL_N}–${PL_MIN_N - 1} flagged “Small sample”). The boldest line that passes is shown.</li>
    <li>Stats come from PitchAPI's player stat lines. Cards come from the card events (regular time). Bookmakers may count tackles, shots and cards differently — check their rules.</li>
    <li>Trend strength = how solid the hit rate is given the sample size (a 9/10 beats a 4/4). Status comes from the published lineup when available.</li>
    <li>No odds are shown: there's no odds server connected. Historical hit rates only — not predictions. 18+ · BeGambleAware.org</li></ul></div>`;
}

// ---------------------------------------------------------------------
// Players screen: best player bets across a league's next fixtures
// ---------------------------------------------------------------------
async function viewPlayers() {
  plInit();
  setNav("players");
  app().innerHTML = `<div class="card hero"><h1 style="font-size:27px">Player bets</h1><p>The strongest player lines across this week's fixtures — shots, tackles, fouls, cards, goals and saves. This season's matches only.</p></div><div id="plComps" style="margin-top:14px">${skeleton(1, 40)}</div><div id="plBody">${skeleton(3, 260)}</div>`;
  if (!hasKey()) { $("#plBody").innerHTML = errorBox(Object.assign(new Error("Connect a data server first."), { hint: "Open Servers and paste your PitchAPI key." })); $("#plComps").innerHTML = ""; return; }
  try { await loadComps(); } catch (e) { $("#plBody").innerHTML = errorBox(e, "reload"); return; }
  $("#plComps").innerHTML = compChips(S.comp).replace(/data-action="comp"/g, 'data-action="plComp"');
  plStartScan();
}
function plScanKey() { return S.comp + "|" + PL.mode; }
async function plStartScan(force) {
  const key = plScanKey();
  let sc = PL.scans[key];
  if (sc && !force && (sc.running || Date.now() - sc.at < 20 * 60000)) { renderPlayersScreen(); return; }
  sc = PL.scans[key] = { running: true, at: Date.now(), fixtures: [], done: 0, current: null, analyses: [], errors: [] };
  renderPlayersScreen();
  let list;
  try { list = await loadFixtures(S.comp); } catch (e) { sc.running = false; sc.error = e; renderPlayersScreen(); return; }
  const until = Date.now() + PL_SCAN_DAYS * 86400000;
  sc.fixtures = list.filter((f) => Date.parse(f.time) <= until).slice(0, PL_SCAN_MAX);
  renderPlayersScreen();
  for (const f of sc.fixtures) {
    if (PL.scans[key] !== sc) return; // a newer scan replaced this one
    sc.current = f;
    try {
      const A = await api(`analysis?comp=${encodeURIComponent(f.comp)}&match=${encodeURIComponent(f.id)}`);
      await plLineups(f.id);
      await plLoad(plIds(A, PL.mode), plSchedule);
      sc.analyses.push(A);
    } catch (e) { sc.errors.push(`${f.home.name} v ${f.away.name}: ${e.message}`); }
    sc.done++;
    plSchedule();
  }
  sc.running = false; sc.current = null; sc.at = Date.now();
  plSchedule();
}
function renderPlayersScreen() {
  const body = $("#plBody"); if (!body || S.route !== "players") return;
  const sc = PL.scans[plScanKey()];
  let html = plModeToggle(null) + plChipRow("plChip");
  if (!sc) { body.innerHTML = html + skeleton(3, 260); return; }
  if (sc.error) { body.innerHTML = html + errorBox(sc.error, "reload"); return; }
  if (sc.running) {
    const tot = sc.fixtures.length || 1;
    html += `<div class="card progress">${sc.current ? `Analysing ${esc(sc.current.home.name)} v ${esc(sc.current.away.name)} · ` : ""}fixture ${Math.min(sc.done + 1, tot)} of ${sc.fixtures.length || "…"}${PL.loading.total ? ` · player stats ${PL.loading.done}/${PL.loading.total}` : ""}<div class="bar"><i style="width:${(100 * sc.done) / tot}%"></i></div><div class="dim" style="margin-top:6px">First scan downloads each team's recent player stats — finished matches are then saved on this phone, so later scans are quick.</div></div>`;
  }
  if (!sc.running && !sc.fixtures.length) { body.innerHTML = html + `<div class="card empty">${ICON.ball}<h3>No fixtures in the next ${PL_SCAN_DAYS} days</h3><p>Pick another league above.</p></div>`; return; }
  const all = sc.analyses.flatMap((A) => buildPlayerProps(A, PL.mode, { chip: PL.filter }));
  all.sort((x, y) => (x.small - y.small) || (y.score - x.score) || (y.line - x.line));
  const list = plFilterList(all, PL.filter, PL.filter === "best" ? 30 : 60);
  if (list.length) {
    html += `<div class="section-title"><h2>${PL.filter === "best" ? "Top player bets" : PL_CHIPS.find((c) => c[0] === PL.filter)[1]}</h2><span class="aside">${sc.analyses.length} of ${sc.fixtures.length} fixtures · ${all.length} lines</span></div>`;
    html += list.map((p) => propCard(p)).join("");
  } else if (!sc.running) html += `<div class="card empty">${ICON.ball}<h3>No player lines at ${PL_MIN_RATE}%+</h3><p>Try another market or “All games”.</p></div>`;
  else html += skeleton(2, 260);
  if (sc.errors.length) html += `<div class="note card small"><b>Skipped:</b><br>${sc.errors.map(esc).join("<br>")}</div>`;
  html += plNote();
  body.innerHTML = html;
}

// ---------------------------------------------------------------------
// Saved player bets (Favourites)
// ---------------------------------------------------------------------
function favPropsSection() {
  plInit();
  const saved = Object.values(S.favProps || {}).sort((a, b) => Date.parse(a.fixture.time) - Date.parse(b.fixture.time));
  if (!saved.length) return `<div class="section-title"><h2>Saved player bets</h2></div><div class="card empty">${ICON.starO.replace("<svg", '<svg width="40" height="40"')}<h3>No saved player bets</h3><p>Tap the ☆ on any player card to keep it here.</p></div>`;
  return `<div class="section-title"><h2>Saved player bets</h2><span class="aside">as saved</span></div>` + saved.map((p) => propCard(p)).join("");
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-action]"); if (!b) return;
  const a = b.dataset.action;
  if (a === "plChip" || a === "plChipM") {
    PL.filter = b.dataset.chip; store.set("plFilter", PL.filter);
    document.querySelectorAll(".pl-chips button").forEach((x) => x.classList.toggle("active", x.dataset.chip === PL.filter));
    if (a === "plChipM") renderMatchBody(); else renderPlayersScreen();
  } else if (a === "plMode") {
    PL.mode = b.dataset.mode; store.set("plMode", PL.mode);
    if (S.route === "players") plStartScan(); else renderMatchBody();
  } else if (a === "plTeam") { PL.team = b.dataset.team; renderMatchBody(); }
  else if (a === "plComp") {
    S.comp = b.dataset.code; store.set("lastComp", S.comp);
    document.querySelectorAll(".chip[data-action=plComp]").forEach((c) => c.classList.toggle("active", c.dataset.code === S.comp));
    plStartScan();
  } else if (a === "favProp") {
    const k = b.dataset.key;
    if (S.favProps[k]) { delete S.favProps[k]; toast("Removed from saved bets"); }
    else { const p = PL.rendered.get(k); if (!p) return; S.favProps[k] = { ...p, savedAt: new Date().toISOString() }; toast("★ Saved to Favourites"); }
    store.set("favProps", S.favProps);
    document.querySelectorAll(`[data-action=favProp][data-key="${CSS.escape(k)}"]`).forEach((x) => { const on = !!S.favProps[k]; x.classList.toggle("on", on); x.innerHTML = on ? ICON.star : ICON.starO; });
  } else if (a === "openFxPlayers") {
    S.tab = "players"; store.set("tab", "players");
    const target = `#/match/${b.dataset.comp}/${b.dataset.id}`;
    if (location.hash === target) renderMatch(); else location.hash = target;
  }
});
