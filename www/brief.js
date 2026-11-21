/* =====================================================================
   DayleeStatCardz — Daily Brief + Ask
   The brief is researched every morning on GitHub's free machines
   (.github/workflows/daily-brief.yml) and published as brief.json on the
   "daily-brief" branch. The app just downloads it — no AI, no cost.
   ===================================================================== */
"use strict";

const BRIEF_URL = "https://raw.githubusercontent.com/iancouslfc-del/dayleestatcardz-app/daily-brief/brief.json";
const BR = { data: null, at: 0, state: "idle", error: null, ask: null, mode: "ask" };
const PSHORT = { FT: "Full match", H1: "1st half", H2: "2nd half" };

// The brief is published packed (v2): pictures listed once in d.imgs, player
// game rows as short arrays. unpackBrief() rebuilds the shapes the screens use.
function unpackBrief(d) {
  if (!d || d.v === 1) return d;
  if (d.v !== 2) throw new Error("Brief format not recognised — update the app.");
  const im = d.imgs || [];
  const pic = (x) => (typeof x === "number" ? im[x] ?? null : x);
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") for (const k in o) { if (k === "img") o[k] = pic(o[k]); else walk(o[k]); } };
  walk(d.fixtures);
  for (const f of d.fixtures) {
    const fixture = { id: f.id, time: f.time, home: f.home, away: f.away };
    for (const p of f.players || []) {
      p.fixture = fixture; p.comp = f.comp;
      p.rows = p.rows.map((r) => (Array.isArray(r) ? { v: r[0], hit: r[1], min: r[2], zf: !!r[3], home: !!r[4], date: r[5], opp: { name: r[6], img: pic(r[7]) }, cs: r[8] || null } : r));
    }
    for (const s of f.streaks || []) { s.fx = { id: f.id, comp: f.comp }; s.team = s.side === "home" ? f.home : f.away; }
  }
  d.v = 1;
  return d;
}
const BRIEF_KEY = "dsc:briefRaw";
function savedBrief() {
  try { const t = localStorage.getItem(BRIEF_KEY); return t ? unpackBrief(JSON.parse(t)) : null; } catch { return null; }
}
function saveBrief(text) {
  try { localStorage.removeItem("dsc:brief"); } catch {}
  // keep a copy for offline use, but never let it crowd out saved match data
  try { if (text.length < 1500000) localStorage.setItem(BRIEF_KEY, text); else localStorage.removeItem(BRIEF_KEY); } catch {}
}

async function loadBrief(force) {
  if (BR.data && !force && Date.now() - BR.at < 10 * 60000) return BR.data;
  if (!BR.data) { const saved = savedBrief(); if (saved) { BR.data = saved; BR.at = 0; } }
  BR.state = "loading";
  try {
    const r = await window.Engine.fetchText(BRIEF_URL + "?t=" + Date.now());
    if (r.status === 404) { BR.state = BR.data ? "ok" : "missing"; return BR.data; }
    if (!r.status) throw new Error("No connection to GitHub.");
    if (r.status !== 200) throw new Error("GitHub error " + r.status);
    const d = unpackBrief(JSON.parse(r.body));
    if (!d || !Array.isArray(d.fixtures)) throw new Error("Brief format not recognised.");
    BR.data = d; BR.at = Date.now(); BR.state = "ok"; BR.error = null;
    saveBrief(r.body);
  } catch (e) { BR.state = BR.data ? "ok" : "error"; BR.error = e.message; }
  return BR.data;
}

const briefAge = (d) => (Date.now() - Date.parse(d.generatedAt)) / 3600e3;
const updatedTxt = (d) => { const t = new Date(d.generatedAt); return `${fmtDay(d.generatedAt)} ${t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })}`; };
const compShort = (code) => ((S.comps || []).find((c) => c.code === code) || {}).short || code;

function allTips(d, withSmall) {
  return d.fixtures.flatMap((f) => [...f.tips, ...(withSmall ? f.small || [] : [])].map((t) => ({ f, t })))
    .sort((a, b) => (a.t.small - b.t.small) || (b.t.score - a.t.score));
}
function allProps(d) {
  return d.fixtures.flatMap((f) => (f.players || []).map((p) => ({ ...p, comp: f.comp, fixture: p.fixture || { id: f.id, time: f.time, home: f.home, away: f.away } })))
    .sort((a, b) => (a.small - b.small) || (b.score - a.score));
}
const statDef = (stat) => PROP_DEFS.find((x) => x.stat === stat);
function streakLabel(stat, line) {
  const def = statDef(stat); const k = Number(line) + 0.5;
  if (stat === "goals") return k === 1 ? "Scored" : `${k}+ goals`;
  if (stat === "assists") return "Assisted";
  if (stat === "ga") return "Goal or assist";
  if (stat === "cards") return "Carded";
  return `${k}+ ${(def && (def.short || def.name)) || stat}`;
}

// ---------- cards ----------
function briefTipCard(f, t, rank) {
  return `<button class="card tip bt" data-action="briefOpen" data-comp="${esc(f.comp)}" data-id="${esc(f.id)}" data-tab="${t.cat}" data-period="${t.period}">
    <div class="bt-fx">${crest(f.home)}${crest(f.away)}<span>${esc(f.home.name)} v ${esc(f.away.name)}</span><em>${kickoff(f.time)} · ${esc(compShort(f.comp))}</em></div>
    <div class="tip-top">${rank ? `<span class="rank">${rank}</span>` : ""}<div class="tip-main"><div class="tip-label">${esc(t.label)}</div><div class="tip-sub">${PSHORT[t.period]} · ${TAB_NAMES[t.cat]}${t.small ? ` · <span class="warn-t">Small sample</span>` : t.strong ? ` · <span class="ok-t">Strong trend</span>` : ""}</div></div>${ring(t.pooled, 48)}</div>
    ${t.legs.map((l) => `<div class="evi"><span>${esc(l.label)}</span><i class="evbar"><i style="width:${l.pct}%;background:${colorOf({ pct: l.pct, n: l.n })}"></i></i><b style="color:${colorOf({ pct: l.pct, n: l.n })}">${l.hits}/${l.n}</b></div>`).join("")}
  </button>`;
}
function streakRow(s, line, f) {
  const len = s.streaks[line];
  const chips = s.vals.map((v, i) => `<i class="${i < len ? "h" : v > Number(line) ? "h2" : "m"}">${v}</i>`).join("");
  return `<button class="card sk" data-action="openFxPlayers" data-comp="${esc(s.fx.comp)}" data-id="${esc(s.fx.id)}">
    <div class="sk-top">${playerPhoto(s.player, s.team)}<div class="sk-who"><b>${esc(s.player.name)}</b><span>${esc(s.team.name)}${f ? ` · v ${esc(s.side === "home" ? f.away.name : f.home.name)} · ${kickoff(f.time)}` : ""}</span></div>
    <div class="sk-num"><b>${len}</b><span>in a row</span></div></div>
    <div class="sk-lbl">${esc(streakLabel(s.stat, line))} <span class="dim">· last ${s.vals.length} games this season, newest first</span></div>
    <div class="sk-chips">${chips}</div>
  </button>`;
}
function totalsRow(f, tab, per, rank) {
  const T = f.totals[tab][per], n = T.home.n + T.away.n;
  const avg = (x, k) => (k ? (x / k).toFixed(2) : "–");
  const comb = n ? (T.home.total + T.away.total) / n : 0;
  return `<button class="card tr" data-action="briefOpen" data-comp="${esc(f.comp)}" data-id="${esc(f.id)}" data-tab="${tab}" data-period="${per}">
    <div class="bt-fx">${rank ? `<span class="rank">${rank}</span>` : ""}${crest(f.home)}${crest(f.away)}<span>${esc(f.home.name)} v ${esc(f.away.name)}</span><em>${kickoff(f.time)}</em></div>
    <div class="tr-grid">
      <div><span>${esc(f.home.name)} home</span><b>${avg(T.home.total, T.home.n)}</b>${S.split ? `<em>${avg(T.home.team, T.home.n)} for<br>${avg(T.home.opp, T.home.n)} against</em>` : `<em>${T.home.total} in ${T.home.n} games</em>`}</div>
      <div><span>${esc(f.away.name)} away</span><b>${avg(T.away.total, T.away.n)}</b>${S.split ? `<em>${avg(T.away.team, T.away.n)} for<br>${avg(T.away.opp, T.away.n)} against</em>` : `<em>${T.away.total} in ${T.away.n} games</em>`}</div>
      <div class="c"><span>Combined</span><b>${comb.toFixed(2)}</b><em>per game</em></div>
    </div></button>`;
}

// ---------- Daily Brief screen ----------
function briefSetupCard() {
  return `<div class="card note"><b>Turn on the free Daily Brief</b><ul>
    <li>On GitHub, open <b>dayleestatcardz-app → Settings → Secrets and variables → Actions</b>.</li>
    <li>Tap <b>New repository secret</b>: name <code>PITCHAPI_KEY</code>, value = your PitchAPI key.</li>
    <li>Open <b>Actions → Daily Brief → Run workflow</b>. About 5–15 minutes later the brief appears here, then refreshes every morning by itself.</li></ul></div>`;
}
async function viewBrief() {
  setNav("home");
  app().innerHTML = `<a class="back" href="#/">${ICON.back} Fixtures</a>${skeleton(1, 150)}${skeleton(3, 150)}`;
  try { await loadComps(); } catch {}
  const d = await loadBrief(true);
  if (S.route !== "brief") return;
  if (!d) {
    app().innerHTML = `<a class="back" href="#/">${ICON.back} Fixtures</a><div class="card hero"><h1 style="font-size:27px">Daily Brief</h1><p>Every morning GitHub researches every fixture for you — free.</p></div>${BR.state === "missing" ? briefSetupCard() : errorBox(new Error(BR.error || "Couldn't load the brief."), "reload")}`;
    return;
  }
  const tips = allTips(d, false).slice(0, 10);
  const props = allProps(d).slice(0, 8);
  const streaks = d.fixtures.flatMap((f) => f.streaks.map((s) => { const best = Object.entries(s.streaks).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0]; return { s, f, line: best[0], len: best[1] }; }))
    .sort((a, b) => b.len - a.len || Number(b.line) - Number(a.line)).slice(0, 10);
  let h = `<a class="back" href="#/">${ICON.back} Fixtures</a>
  <div class="card hero brief-hero"><div class="bh-row"><div><div class="kicker-s">Researched automatically · free</div><h1 style="font-size:28px">Daily Brief</h1></div><button class="icon-btn" data-action="briefRefresh" aria-label="Refresh">↻</button></div>
    <p>${d.fixtures.length} fixtures in the next ${d.hours} hours, every league. Updated <b>${updatedTxt(d)}</b>.</p>
    <div class="hero-stats"><div class="hero-stat"><div class="n">${d.fixtures.length}</div><div class="l">Fixtures</div></div><div class="hero-stat"><div class="n">${allTips(d, false).length}</div><div class="l">Team tips</div></div><div class="hero-stat"><div class="n">${d.fixtures.reduce((a, f) => a + f.streaks.length, 0)}</div><div class="l">Player streaks</div></div></div></div>`;
  if (briefAge(d) > 30) h += `<div class="card note small" style="border-color:rgba(255,184,77,.35)"><b>This brief is from ${updatedTxt(d)}.</b> The daily run may be paused — on GitHub open Actions → Daily Brief → Run workflow.</div>`;
  if (BR.error) h += `<div class="note card small">Showing the last saved brief — ${esc(BR.error)}</div>`;
  if (!d.fixtures.length) h += `<div class="card empty">${ICON.ball}<h3>No fixtures in this window</h3><p>Nothing kicks off in the next ${d.hours} hours.</p></div>`;
  if (tips.length) h += `<div class="section-title"><h2>Top team bets</h2><span class="aside">Both sides 70%+</span></div>` + tips.map(({ f, t }, i) => briefTipCard(f, t, i + 1)).join("");
  if (props.length) h += `<div class="section-title"><h2>Top player bets</h2><span class="aside">45+ mins · this season</span></div>` + props.map((p) => propCard(p)).join("");
  if (streaks.length) h += `<div class="section-title"><h2>Longest streaks</h2><span class="aside">all games this season</span></div>` + streaks.map((x) => streakRow(x.s, x.line, x.f)).join("");
  if (d.fixtures.length) h += `<div class="section-title"><h2>Every fixture</h2><span class="aside">tap for full stats</span></div>` + d.fixtures.map((f) => fixtureCard({ ...f, comp: f.comp }, true)).join("");
  if (d.errors && d.errors.length) h += `<details class="note card small"><summary>Notes from today's run (${d.errors.length})</summary><ul>${d.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>`;
  h += `<div class="note card small">Historical hit rates only — not predictions. Ask screen lets you search everything in this brief. 18+ · BeGambleAware.org</div>`;
  app().innerHTML = h;
}

// Home: small banner
async function briefBanner() {
  const el = $("#briefBanner"); if (!el) return;
  const d = await loadBrief(false);
  const box = $("#briefBanner"); if (!box) return;
  if (!d) { if (BR.state === "missing") box.innerHTML = `<a class="card bb" href="#/brief"><div class="bb-top"><span class="bb-badge">★</span><div><b>Daily Brief</b><span>Free autopilot research every morning · tap to switch on</span></div><span class="go">SET UP ${ICON.chev}</span></div></a>`; return; }
  if (!d.fixtures.length) return;
  const top = allTips(d, false).slice(0, 2);
  box.innerHTML = `<a class="card bb" href="#/brief"><div class="bb-top"><span class="bb-badge">★</span><div><b>Daily Brief</b><span>${d.fixtures.length} fixtures · updated ${updatedTxt(d)}</span></div><span class="go">OPEN ${ICON.chev}</span></div>
    ${top.map(({ f, t }) => `<div class="bb-pick"><span>${esc(f.home.name)} v ${esc(f.away.name)}</span><b>${esc(t.label)} · ${PSHORT[t.period]}</b><em style="color:${colorOf({ pct: t.pooled, n: t.n })}">${Math.round(t.pooled)}%</em></div>`).join("")}</a>`;
}

// ---------- Ask screen ----------
const ASK_STATS = ["shots", "sot", "tackles", "fouls", "fouled", "goals", "assists", "ga", "cards", "saves"];
function askState() {
  if (!BR.ask) BR.ask = store.get("ask", { sStat: "shots", sLine: "0.5", sN: 5, tCat: "any", tPer: "any", tMin: 80, tSmall: false, oTab: "goals", oPer: "H1", pStat: "shots", pMin: 80 });
  return BR.ask;
}
const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(l)}</option>`;

async function viewAsk() {
  setNav("search");
  const seg = `<div class="ask-seg"><button class="${BR.mode === "ask" ? "active" : ""}" data-action="askMode" data-mode="ask">Ask the stats</button><button class="${BR.mode === "find" ? "active" : ""}" data-action="askMode" data-mode="find">Find a fixture</button></div>`;
  if (BR.mode === "find") { viewSearch(); app().insertAdjacentHTML("afterbegin", seg); return; }
  app().innerHTML = seg + skeleton(4, 120);
  try { await loadComps(); } catch {}
  const d = await loadBrief(false);
  if (S.route !== "search" || BR.mode !== "ask") return;
  if (!d) { app().innerHTML = seg + (BR.state === "missing" ? briefSetupCard() : errorBox(new Error(BR.error || "Couldn't load the Daily Brief."), "reload")); return; }
  const a = askState();
  const lines = (statDef(a.sStat) || { lines: [0.5] }).lines;
  if (!lines.map(String).includes(String(a.sLine))) a.sLine = String(lines[0]);
  app().innerHTML = seg + `<p class="muted small" style="margin:10px 2px 0">Answers come from today's Daily Brief (${d.fixtures.length} fixtures, updated ${updatedTxt(d)}) — instant, works offline.</p>
  <div class="card ask"><div class="aq">Players with
    <select data-ask="sLine">${lines.map((l) => opt(l, (l + 0.5) + "+", a.sLine)).join("")}</select>
    <select data-ask="sStat">${ASK_STATS.map((s) => opt(s, (statDef(s).short || statDef(s).name), a.sStat)).join("")}</select>
    in <select data-ask="sN">${[3, 4, 5, 6, 7, 8, 9, 10].map((n) => opt(n, n + "+", a.sN)).join("")}</select> games in a row</div><div id="askS"></div></div>
  <div class="card ask"><div class="aq">Team bets in
    <select data-ask="tCat">${opt("any", "any market", a.tCat)}${opt("goals", "goals", a.tCat)}${opt("corners", "corners", a.tCat)}${opt("cards", "cards", a.tCat)}</select>
    for <select data-ask="tPer">${opt("any", "any period", a.tPer)}${opt("FT", "full match", a.tPer)}${opt("H1", "1st half", a.tPer)}${opt("H2", "2nd half", a.tPer)}</select>
    hitting <select data-ask="tMin">${[70, 80, 90, 100].map((n) => opt(n, n + "%+", a.tMin)).join("")}</select> for both sides</div><div id="askT"></div></div>
  <div class="card ask"><div class="aq">Highest
    <select data-ask="oTab">${opt("goals", "goals", a.oTab)}${opt("corners", "corners", a.oTab)}${opt("cards", "cards", a.oTab)}</select>
    in the <select data-ask="oPer">${opt("H1", "1st half", a.oPer)}${opt("H2", "2nd half", a.oPer)}${opt("FT", "full match", a.oPer)}</select></div><div class="aq-sub">${splitSwitch()}</div><div id="askO"></div></div>
  <div class="card ask"><div class="aq">Player
    <select data-ask="pStat">${["shots", "sot", "tackles", "fouls", "fouled", "goals", "assists", "cards", "saves"].map((s) => opt(s, (statDef(s).short || statDef(s).name), a.pStat)).join("")}</select>
    lines hitting <select data-ask="pMin">${[70, 80, 90, 100].map((n) => opt(n, n + "%+", a.pMin)).join("")}</select></div><div id="askP"></div></div>`;
  renderAsk(d);
}

function renderAsk(d) {
  const a = askState();
  const more = (n, shown) => (n > shown ? `<div class="dim small" style="margin-top:8px">Showing the top ${shown} of ${n}.</div>` : "");
  // streaks
  const S1 = d.fixtures.flatMap((f) => f.streaks.filter((s) => s.stat === a.sStat && (s.streaks[a.sLine] || 0) >= a.sN).map((s) => ({ s, f })))
    .sort((x, y) => y.s.streaks[a.sLine] - x.s.streaks[a.sLine]);
  $("#askS").innerHTML = S1.length ? S1.slice(0, 15).map(({ s, f }) => streakRow(s, a.sLine, f)).join("") + more(S1.length, 15) : `<p class="muted small">No player in today's fixtures has done that ${a.sN}+ games in a row this season.</p>`;
  // team bets
  const S2 = allTips(d, a.tSmall).filter(({ t }) => (a.tCat === "any" || t.cat === a.tCat) && (a.tPer === "any" || t.period === a.tPer) && t.legs.every((l) => l.pct >= a.tMin));
  $("#askT").innerHTML = S2.length ? S2.slice(0, 12).map(({ f, t }) => briefTipCard(f, t, null)).join("") + more(S2.length, 12) : `<p class="muted small">No team bet in today's brief reaches ${a.tMin}% for both sides on that selection.</p>`;
  // totals
  const S3 = d.fixtures.filter((f) => f.totals[a.oTab][a.oPer].home.n + f.totals[a.oTab][a.oPer].away.n > 0)
    .map((f) => { const T = f.totals[a.oTab][a.oPer]; return { f, avg: (T.home.total + T.away.total) / (T.home.n + T.away.n) }; }).sort((x, y) => y.avg - x.avg);
  $("#askO").innerHTML = S3.length ? S3.slice(0, 10).map(({ f }, i) => totalsRow(f, a.oTab, a.oPer, i + 1)).join("") + more(S3.length, 10) : `<p class="muted small">No data yet.</p>`;
  // player lines
  const S4 = allProps(d).filter((p) => p.stat === a.pStat && p.pct >= a.pMin);
  $("#askP").innerHTML = (S4.length ? S4.slice(0, 10).map((p) => propCard(p)).join("") + more(S4.length, 10) : `<p class="muted small">No ${esc((statDef(a.pStat).short || statDef(a.pStat).name).toLowerCase())} line at ${a.pMin}%+ among today's top player bets.</p>`)
    + `<div class="dim small" style="margin-top:6px">Searches the strongest player lines the brief kept for each match (up to 10 per game).</div>`;
}

// ---------- events ----------
document.addEventListener("change", (ev) => {
  const sel = ev.target.closest("select[data-ask]"); if (!sel) return;
  const a = askState(); const k = sel.dataset.ask;
  a[k] = ["sN", "tMin", "pMin"].includes(k) ? Number(sel.value) : sel.value;
  store.set("ask", a);
  if (k === "sStat") viewAsk(); else if (BR.data) renderAsk(BR.data);
});
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-action]"); if (!b) return;
  const a = b.dataset.action;
  if (a === "briefOpen") {
    S.tab = b.dataset.tab; store.set("tab", S.tab);
    S.period = b.dataset.period; store.set("period", S.period); S.lastPeriod = S.period;
    const target = `#/match/${b.dataset.comp}/${b.dataset.id}`;
    if (location.hash === target) renderMatch(); else location.hash = target;
  } else if (a === "briefRefresh") { toast("Checking for a newer brief…"); BR.at = 0; viewBrief(); }
  else if (a === "askMode") { BR.mode = b.dataset.mode; viewAsk(); }
  else if (a === "split" && S.route === "search" && BR.data) {
    setTimeout(() => { const sw = $(".ask .switch"); if (sw) { sw.classList.toggle("on", S.split); sw.setAttribute("aria-pressed", S.split); } renderAsk(BR.data); }, 0);
  }
});
