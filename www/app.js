/* =====================================================================
   DayleeStatCardz — front end (no build step, no libraries)
   Every number on screen is calculated here from real match records
   returned by /api. Nothing is estimated, averaged or invented.
   ===================================================================== */
"use strict";

// ---------------------------------------------------------------------
// Market definitions. `metric` decides which number is tested:
//   total = both teams combined, team = the analysed team,
//   opp = the analysed team's opponent, min = the lower of the two
//   (so "min > 0.5" means BOTH teams reached 1+).
// A market wins when metric value > line.
// ---------------------------------------------------------------------
const MARKETS = {
  goals: [
    { group: "Match goals" },
    { id: "o05", label: "Over 0.5 goals", metric: "total", line: 0.5 },
    { id: "o15", label: "Over 1.5 goals", metric: "total", line: 1.5 },
    { id: "o25", label: "Over 2.5 goals", metric: "total", line: 2.5 },
    { id: "o35", label: "Over 3.5 goals", metric: "total", line: 3.5 },
    { id: "btts", label: "Both teams to score", metric: "min", line: 0.5 },
    { group: "Team" },
    { id: "ts1", label: "Team scores 1+", metric: "team", line: 0.5 },
    { id: "ts2", label: "Team scores 2+", metric: "team", line: 1.5 },
    { id: "tc1", label: "Team concedes 1+", metric: "opp", line: 0.5 },
  ],
  corners: [
    { group: "Match corners" },
    { id: "c1", label: "1+ total corners", metric: "total", line: 0.5 },
    { id: "c3", label: "3+ total corners", metric: "total", line: 2.5 },
    { id: "c5", label: "5+ total corners", metric: "total", line: 4.5 },
    { id: "c7", label: "7+ total corners", metric: "total", line: 6.5 },
    { id: "c9", label: "9+ total corners", metric: "total", line: 8.5 },
    { id: "c10", label: "10+ total corners", metric: "total", line: 9.5 },
    { group: "Team" },
    { id: "tc1c", label: "Team 1+ corners", metric: "team", line: 0.5 },
    { id: "tc3c", label: "Team 3+ corners", metric: "team", line: 2.5 },
    { id: "tc5c", label: "Team 5+ corners", metric: "team", line: 4.5 },
    { id: "bc1", label: "Both teams 1+ corners", metric: "min", line: 0.5 },
    { id: "bc3", label: "Both teams 3+ corners", metric: "min", line: 2.5 },
  ],
  cards: [
    { group: "Match cards" },
    { id: "k05", label: "Over 0.5 cards", metric: "total", line: 0.5 },
    { id: "k15", label: "Over 1.5 cards", metric: "total", line: 1.5 },
    { id: "k25", label: "Over 2.5 cards", metric: "total", line: 2.5 },
    { id: "k35", label: "Over 3.5 cards", metric: "total", line: 3.5 },
    { id: "k45", label: "Over 4.5 cards", metric: "total", line: 4.5 },
    { id: "k55", label: "Over 5.5 cards", metric: "total", line: 5.5 },
    { id: "kb1", label: "Both teams carded", metric: "min", line: 0.5 },
    { group: "Team" },
    { id: "kt1", label: "Team 1+ cards", metric: "team", line: 0.5 },
    { id: "kt2", label: "Team 2+ cards", metric: "team", line: 1.5 },
    { id: "ko1", label: "Opponent 1+ cards", metric: "opp", line: 0.5 },
  ],
};
const PERIODS = { H1: "1st Half", H2: "2nd Half", FT: "Full Match" };
const TAB_NAMES = { goals: "Goals", corners: "Corners", cards: "Cards" };
const HERO_DEFAULT = { goals: "o25", corners: "c9", cards: "k35" };
const UNIT = { goals: "goals", corners: "corners", cards: "cards" };

// ---------------------------------------------------------------------
// State + storage
// ---------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem("dsc:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("dsc:" + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem("dsc:" + k); } catch {} },
};

const S = {
  comps: null,
  comp: store.get("lastComp", null),
  fixtures: {},           // code -> { list, at }
  analysis: null,          // current analysis payload
  details: new Map(),      // match id -> normalised detail
  detailErr: new Map(),    // match id -> error message
  loading: { total: 0, done: 0 },
  tab: store.get("tab", "goals"),
  period: store.get("period", "FT"),
  hero: {},                // tab -> market id
  favTeams: store.get("favTeams", {}),   // id -> {id,name,img}
  favComps: store.get("favComps", []),
  route: "",
};

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
async function api(path) {
  try { return await window.Engine.call(path); }
  catch (e) { throw Object.assign(new Error(e.message || "Something went wrong."), { code: e.code, hint: e.hint }); }
}
const hasKey = () => !!(store.get("keys", {}).pitch || "").trim();

async function loadComps(force) {
  if (S.comps && !force) return S.comps;
  const d = await api("competitions");
  S.comps = d.competitions;
  if (!S.comp || !S.comps.find((c) => c.code === S.comp)) S.comp = (S.favComps[0] && S.comps.find((c) => c.code === S.favComps[0])) ? S.favComps[0] : S.comps[0].code;
  return S.comps;
}

async function loadFixtures(code, force) {
  const c = S.fixtures[code];
  if (c && !force && Date.now() - c.at < 5 * 60000) return c.list;
  const d = await api("fixtures?comp=" + encodeURIComponent(code));
  S.fixtures[code] = { list: d.fixtures, at: Date.now(), errors: d.errors || [] };
  return d.fixtures;
}

// Match detail cache: finished + complete matches never change, so keep them on the phone.
function cachedDetail(id) {
  if (S.details.has(id)) return S.details.get(id);
  const d = store.get("m:" + id, null);
  if (d && d.complete) { S.details.set(id, d); return d; }
  return null;
}
function saveDetail(d) {
  S.details.set(d.id, d);
  if (!d.complete) return;
  const idx = store.get("mIndex", []);
  idx.push(d.id);
  while (idx.length > 400) store.del("m:" + idx.shift());
  store.set("mIndex", idx);
  store.set("m:" + d.id, d);
}

async function loadDetails(ids, onProgress) {
  const todo = ids.filter((id) => !cachedDetail(id));
  S.loading = { total: todo.length, done: 0 };
  onProgress();
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try { saveDetail(await api("match?id=" + id)); S.detailErr.delete(id); }
      catch (e) { S.detailErr.set(id, e.message); }
      S.loading.done++;
      onProgress();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
}

// ---------------------------------------------------------------------
// Calculation engine
// ---------------------------------------------------------------------
const sameScore = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

// Goals for one match (regular time). HT prefers football-data.org's official
// half-time score when that provider verified the same fixture.
function goalsFor(m, d) {
  let rt = null, rtNote = "";
  if (d && d.rt) rt = d.rt;
  else if (d && d.et) rt = null;
  else rt = m.score; // league matches: no extra time
  let ht = null, htSrc = null, conflict = false;
  const fdHt = m.fd && m.fd.status === "verified" ? m.fd.ht : null;
  if (fdHt) { ht = fdHt; htSrc = "football-data.org"; if (d && d.ht && !sameScore(d.ht, fdHt)) conflict = true; }
  else if (d && d.ht) { ht = d.ht; htSrc = "PitchAPI events"; }
  if (rt && ht && (rt[0] < ht[0] || rt[1] < ht[1])) { ht = null; htSrc = null; rtNote = "HT score inconsistent with FT"; }
  return { rt, ht, htSrc, conflict, rtNote };
}

// Returns { v:[home,away] } or { missing: reason } for a match/tab/period.
function valuesFor(tab, period, m, d) {
  if (tab === "goals") {
    const g = goalsFor(m, d);
    if (period === "FT") return g.rt ? { v: g.rt, g } : { missing: d ? "Regular-time score unavailable (extra time)" : "Loading…", pending: !d };
    if (!g.ht) return { missing: d ? "Half-time score unavailable" : "Loading…", pending: !d && !S.detailErr.has(m.id) };
    if (period === "H1") return { v: g.ht, g };
    if (!g.rt) return { missing: "Regular-time score unavailable" };
    return { v: [g.rt[0] - g.ht[0], g.rt[1] - g.ht[1]], g };
  }
  if (!d) {
    const err = S.detailErr.get(m.id);
    return err ? { missing: "Stats request failed: " + err } : { missing: "Loading…", pending: true };
  }
  if (tab === "corners") {
    const c = d.corners && d.corners[period];
    return c ? { v: c } : { missing: `No ${PERIODS[period].toLowerCase()} corner data from provider` };
  }
  const k = d.cards && d.cards[period];
  if (!k) return { missing: `No ${PERIODS[period].toLowerCase()} card data from provider` };
  return { v: [k.y[0] + k.r[0], k.y[1] + k.r[1]], cards: k };
}

function metricOf(mk, v, t) {
  if (mk.metric === "total") return v[0] + v[1];
  if (mk.metric === "team") return v[t];
  if (mk.metric === "opp") return v[1 - t];
  return Math.min(v[0], v[1]);
}

function evalSide(side, mk, tab, period) {
  const t = side.side === "home" ? 0 : 1;
  const rows = side.sample.map((m) => {
    const d = cachedDetail(m.id);
    const r = valuesFor(tab, period, m, d);
    if (!r.v) return { m, d, missing: r.missing, pending: r.pending };
    const x = metricOf(mk, r.v, t);
    return { m, d, v: r.v, x, hit: x > mk.line, g: r.g, cards: r.cards };
  });
  const used = rows.filter((r) => r.v);
  const hits = used.filter((r) => r.hit).length;
  return { side: side.side, rows, n: used.length, hits, pct: used.length ? (100 * hits) / used.length : null, pending: rows.some((r) => r.pending), sampleSize: side.sample.length };
}

function rateClass(p, n) { if (p === null || !n) return "na"; return p >= 70 ? "g" : p >= 50 ? "a" : "r"; }
const fmtPct = (p) => (p === null ? "—" : Math.round(p) + "%");

// ---------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const app = () => $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const initials = (name) => esc(String(name || "?").replace(/\b(FC|AFC|CF|SC|AC|EC)\b/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase());
const short3 = (name) => esc(String(name || "").replace(/^(FC|AFC|AC|SC|CA|CR|SE|EC)\s+/i, "").replace(/[^A-Za-zÀ-ÿ]/g, "").slice(0, 3).toUpperCase());

function crest(team, lg) {
  if (!team) return "";
  const cls = lg ? "crest-lg" : "crest";
  if (team.img) return `<img class="${cls}" src="${esc(team.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;mono${lg ? " lg" : ""}&quot;>${initials(team.name)}</span>'">`;
  return `<span class="mono${lg ? " lg" : ""}">${initials(team.name)}</span>`;
}
function compLogo(c) {
  if (c && c.logo) return `<img class="logo" src="${esc(c.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
  return `<span class="mono">${esc((c?.short || "?").slice(0, 3))}</span>`;
}
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
const fmtDay = (iso) => {
  const d = new Date(iso), today = new Date();
  const key = (x) => x.toLocaleDateString("en-GB", { timeZone: tz });
  const tmr = new Date(Date.now() + 86400000);
  if (key(d) === key(today)) return "Today";
  if (key(d) === key(tmr)) return "Tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
};
const fmtShortDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: tz });

const ICON = {
  star: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z"/></svg>`,
  starO: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="#1ee38b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9H3z"/></svg>`,
  plane: `<svg viewBox="0 0 24 24" fill="none" stroke="#5fb4ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16l20-6-20-6 4 6z"/></svg>`,
  back: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  chev: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>`,
  ball: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/></svg>`,
};

function errorBox(e, retry) {
  return `<div class="card error">${ICON.alert}<h3>Couldn't load that</h3><p>${esc(e.message)}</p>${e.hint ? `<div class="hint">${esc(e.hint)}</div>` : ""}
  <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${retry ? `<button class="btn primary" data-action="${retry}">Try again</button>` : ""}<a class="btn" href="#/sources" style="display:inline-grid;place-items:center">Data servers</a></div></div>`;
}
const skeleton = (n, h = 76) => Array.from({ length: n }, () => `<div class="skel" style="height:${h}px;margin-bottom:8px"></div>`).join("");

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800); }

// ---------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------
// items: [{ value|null, hit, label, sub }] oldest → newest
function barChart(items, line, opts = {}) {
  const W = 340, H = opts.h || 150, padL = 22, padR = 40, padT = 18, padB = 26;
  const n = Math.max(items.length, 1);
  const vals = items.map((i) => i.value).filter((v) => v !== null && v !== undefined);
  const max = Math.max(line + 1.5, ...vals, 1);
  const top = Math.ceil(max);
  const plotH = H - padT - padB, plotW = W - padL - padR;
  const slot = plotW / Math.max(n, 6);
  const bw = Math.min(22, slot * 0.62);
  const y = (v) => padT + plotH - (v / top) * plotH;
  let s = `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || "chart")}">`;
  s += `<defs><linearGradient id="gW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3cf5a2"/><stop offset="1" stop-color="#0c9c5f"/></linearGradient>
  <linearGradient id="gL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6b85"/><stop offset="1" stop-color="#b8263f"/></linearGradient>
  <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#1b2320"/><line x1="0" y1="0" x2="0" y2="5" stroke="#2c3632" stroke-width="2"/></pattern></defs>`;
  // grid
  const step = top <= 5 ? 1 : top <= 10 ? 2 : top <= 20 ? 5 : 10;
  for (let g = 0; g <= top; g += step) {
    s += `<line x1="${padL}" x2="${W - padR + 4}" y1="${y(g)}" y2="${y(g)}" stroke="rgba(255,255,255,.06)"/>`;
    s += `<text x="${padL - 6}" y="${y(g) + 3.5}" text-anchor="end" font-size="9" fill="#5d6862">${g}</text>`;
  }
  items.forEach((it, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - bw / 2;
    if (it.value === null || it.value === undefined) {
      s += `<rect x="${x}" y="${y(top * 0.35)}" width="${bw}" height="${y(0) - y(top * 0.35)}" rx="4" fill="url(#hatch)"/>`;
      s += `<text x="${cx}" y="${y(top * 0.35) - 4}" text-anchor="middle" font-size="9" fill="#5d6862">n/a</text>`;
    } else {
      const h = Math.max(y(0) - y(it.value), 2.5);
      s += `<rect x="${x}" y="${y(0) - h}" width="${bw}" height="${h}" rx="4" fill="url(#${it.hit ? "gW" : "gL"})"/>`;
      s += `<text x="${cx}" y="${y(0) - h - 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${it.hit ? "#1ee38b" : "#ff6b85"}">${it.value}</text>`;
    }
    s += `<text x="${cx}" y="${H - 12}" text-anchor="middle" font-size="8.5" font-weight="600" fill="#8b9690">${it.label || ""}</text>`;
    if (it.sub) s += `<text x="${cx}" y="${H - 2}" text-anchor="middle" font-size="7.5" fill="#5d6862">${it.sub}</text>`;
  });
  // threshold line
  const ly = y(line);
  s += `<line x1="${padL}" x2="${W - 34}" y1="${ly}" y2="${ly}" stroke="#ffb84d" stroke-width="1.4" stroke-dasharray="5 4"/>`;
  s += `<rect x="${W - 34}" y="${ly - 9}" width="34" height="16" rx="4" fill="#ffb84d"/><text x="${W - 17}" y="${ly + 3}" text-anchor="middle" font-size="9.5" font-weight="800" fill="#1a1204">${line}</text>`;
  return s + `</svg>`;
}

function ring(p, size = 52) {
  const r = 21, c = 2 * Math.PI * r, val = p === null ? 0 : p / 100;
  const col = p === null ? "#5d6862" : p >= 70 ? "#1ee38b" : p >= 50 ? "#ffb84d" : "#ff4f6d";
  return `<svg class="ring" viewBox="0 0 52 52" width="${size}" height="${size}"><circle cx="26" cy="26" r="${r}" fill="none" stroke="#1b2320" stroke-width="5"/>
  <circle cx="26" cy="26" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c * val} ${c}" transform="rotate(-90 26 26)"/>
  <text x="26" y="31" text-anchor="middle" font-size="15" fill="#eef4f0">${p === null ? "—" : Math.round(p)}</text></svg>`;
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------
function setNav(name) { document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === name)); }

function compChips(active, includeAll) {
  const comps = S.comps || [];
  const ordered = [...comps].sort((a, b) => (S.favComps.includes(b.code) - S.favComps.includes(a.code)));
  return `<div class="chips">${includeAll ? `<button class="chip text ${active === "ALL" ? "active" : ""}" data-action="comp" data-code="ALL">All leagues</button>` : ""}
  ${ordered.map((c) => `<button class="chip ${c.code === active ? "active" : ""}" data-action="comp" data-code="${c.code}">${compLogo(c)}${esc(c.name)}${S.favComps.includes(c.code) ? " ★" : ""}</button>`).join("")}</div>`;
}

function fixtureCard(f, showComp) {
  const comp = (S.comps || []).find((c) => c.code === f.comp);
  return `<a class="fixture" href="#/match/${f.comp}/${f.id}">
    <div class="teams">
      <div class="team">${crest(f.home)}<span>${esc(f.home.name)}</span></div>
      <div class="team">${crest(f.away)}<span>${esc(f.away.name)}</span></div>
    </div>
    <div class="meta"><div class="time">${fmtTime(f.time)}</div>${showComp && comp ? `<span class="comp-tag">${esc(comp.short)}</span>` : ""}<span class="go">STATS ${ICON.chev}</span></div>
  </a>`;
}

function fixtureList(list, showComp) {
  if (!list.length) return `<div class="card empty">${ICON.ball}<h3>No upcoming fixtures</h3><p>Nothing scheduled in the next 3 weeks for this selection.</p></div>`;
  let out = "", day = "";
  for (const f of list) {
    const d = fmtDay(f.time);
    if (d !== day) { out += `<div class="day-head">${d}</div>`; day = d; }
    out += fixtureCard(f, showComp);
  }
  return out;
}

async function viewHome() {
  setNav("home");
  const root = app();
  if (!hasKey()) {
    root.innerHTML = `<div class="card hero"><h1>Connect a data<br>server to start.</h1><p>Paste your free PitchAPI key once. Fixtures, results, corners and cards then load by themselves.</p>
      <div style="margin-top:16px;position:relative;z-index:1"><a class="btn primary" href="#/sources" style="display:inline-grid;place-items:center;height:46px;padding:0 20px">Connect data server</a></div></div>
      <div class="card note small" style="margin-top:12px"><b>How it works</b><ul><li>Home team: its last 10 <b>home</b> matches. Away team: its last 10 <b>away</b> matches.</li><li>Goals, corners and cards for 1st half, 2nd half and full match.</li><li>Tap any % to see every match behind it.</li></ul></div>`;
    return;
  }
  root.innerHTML = `<div class="card hero"><h1>Last 10 home.<br>Last 10 away.</h1><p>Real hit rates for goals, corners & cards — tap any % to see every match behind it.</p>
    <div class="hero-stats" id="heroStats"><div class="hero-stat"><div class="n">6</div><div class="l">Leagues</div></div><div class="hero-stat"><div class="n" id="hsFix">—</div><div class="l">Fixtures (21 days)</div></div><div class="hero-stat"><div class="n">0</div><div class="l">Made-up stats</div></div></div></div>
    <div id="chipsWrap" style="margin-top:14px">${skeleton(1, 40)}</div><div id="fxWrap" style="margin-top:4px">${skeleton(5)}</div>`;
  try {
    await loadComps();
    $("#chipsWrap").innerHTML = compChips(S.comp);
  } catch (e) { $("#chipsWrap").innerHTML = ""; $("#fxWrap").innerHTML = errorBox(e, "reload"); return; }
  try {
    const list = await loadFixtures(S.comp);
    if (S.route !== "home") return;
    $("#fxWrap").innerHTML = fixtureList(list, false);
    $("#hsFix").textContent = list.length;
  } catch (e) { $("#fxWrap").innerHTML = errorBox(e, "reload"); }
}

// ---------- Match analysis ----------
async function viewMatch(code, id) {
  setNav("home");
  const root = app();
  const sameMatch = S.analysis && S.analysis.fixture.id === id;
  if (!sameMatch) {
    S.analysis = null;
    root.innerHTML = `<a class="back" href="#/">${ICON.back} Fixtures</a>${skeleton(1, 190)}${skeleton(1, 60)}${skeleton(8, 50)}`;
    try { await loadComps(); S.analysis = await api(`analysis?comp=${encodeURIComponent(code)}&match=${encodeURIComponent(id)}`); }
    catch (e) { root.innerHTML = `<a class="back" href="#/">${ICON.back} Fixtures</a>` + errorBox(e, "reload"); return; }
    if (S.route !== "match") return;
  }
  renderMatch();
  const ids = [...new Set([...S.analysis.home.sample, ...S.analysis.away.sample].map((m) => m.id))];
  loadDetails(ids, () => { if (S.route === "match" && S.analysis && S.analysis.fixture.id === id) renderMatchBody(); });
}

function renderMatch() {
  const A = S.analysis, f = A.fixture;
  const fav = (t) => !!S.favTeams[t.id];
  const nH = A.home.sample.length, nA = A.away.sample.length;
  app().innerHTML = `
  <a class="back" href="#/">${ICON.back} Fixtures</a>
  <div class="card match-head">
    <div class="mh-comp">${A.competition.logo ? `<img src="${esc(A.competition.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}${esc(A.competition.name)}${f.round ? ` · Round ${esc(f.round)}` : ""}</div>
    <div class="mh-grid">
      <div class="mh-team">${crest(f.home, true)}<div class="name">${esc(f.home.name)}</div><div class="role">Home</div>
        <button class="star ${fav(f.home) ? "on" : ""}" data-action="favTeam" data-side="home" aria-label="Favourite">${fav(f.home) ? ICON.star : ICON.starO}</button></div>
      <div class="mh-vs"><div class="t">${fmtTime(f.time)}</div><div class="d">${fmtDay(f.time)}</div></div>
      <div class="mh-team">${crest(f.away, true)}<div class="name">${esc(f.away.name)}</div><div class="role" style="color:var(--blue)">Away</div>
        <button class="star ${fav(f.away) ? "on" : ""}" data-action="favTeam" data-side="away" aria-label="Favourite">${fav(f.away) ? ICON.star : ICON.starO}</button></div>
    </div>
    <div class="mh-foot">${f.referee ? `<span>Referee: <b style="color:var(--text)">${esc(f.referee)}</b></span>` : ""}${f.stadium ? `<span>${esc(f.stadium)}</span>` : ""}</div>
  </div>
  <div class="card rule">
    <div class="r"><span class="ic">${ICON.home}</span><div><b>${esc(f.home.name)}</b>Last <span class="n ${nH < 10 ? "low" : ""}">${nH}</span> HOME matches</div></div>
    <div class="r"><span class="ic">${ICON.plane}</span><div><b>${esc(f.away.name)}</b>Last <span class="n ${nA < 10 ? "low" : ""}">${nA}</span> AWAY matches</div></div>
  </div>
  <div class="tabs">
    <div class="tabbar">${Object.keys(TAB_NAMES).map((t) => `<button class="${S.tab === t ? "active" : ""}" data-action="tab" data-tab="${t}">${TAB_NAMES[t]}</button>`).join("")}</div>
    <div class="seg">${["H1", "H2", "FT"].map((p) => `<button class="${S.period === p ? "active" : ""}" data-action="period" data-period="${p}">${PERIODS[p]}</button>`).join("")}</div>
  </div>
  <div id="mBody"></div>`;
  renderMatchBody();
}

function renderMatchBody() {
  const el = $("#mBody"); if (!el || !S.analysis) return;
  const A = S.analysis, tab = S.tab, period = S.period;
  const rows = MARKETS[tab].filter((m) => !m.group).map((mk) => ({ mk, h: evalSide(A.home, mk, tab, period), a: evalSide(A.away, mk, tab, period) }));
  const L = S.loading;
  let html = "";
  if (L.total && L.done < L.total) {
    html += `<div class="card progress">Loading match stats ${L.done}/${L.total} — corners & cards fill in as each match arrives<div class="bar"><i style="width:${(100 * L.done) / L.total}%"></i></div></div>`;
  }
  // Strongest trends (both sides ≥70%, at least 6 matches each)
  const trends = rows.filter((r) => r.h.n >= 6 && r.a.n >= 6 && r.h.pct >= 70 && r.a.pct >= 70)
    .map((r) => ({ ...r, pooled: (100 * (r.h.hits + r.a.hits)) / (r.h.n + r.a.n) }))
    .sort((x, y) => y.pooled - x.pooled || y.mk.line - x.mk.line).slice(0, 6);
  if (trends.length) {
    html += `<div class="section-title"><h2>Strongest trends</h2><span class="aside">Both sides ≥70%</span></div><div class="trends">`;
    html += trends.map((r) => `<button class="card trend" data-action="market" data-id="${r.mk.id}"><div class="top">${ring(r.pooled)}<div><div class="lbl">${esc(r.mk.label)}</div><div class="sub">${PERIODS[period]}</div></div></div>
      <div class="sub">${esc(A.home.team.name)} ${r.h.hits}/${r.h.n} · ${esc(A.away.team.name)} ${r.a.hits}/${r.a.n}</div></button>`).join("");
    html += `</div>`;
  }
  // Hero chart
  const heroId = S.hero[tab] || HERO_DEFAULT[tab];
  const totals = MARKETS[tab].filter((m) => m.metric === "total");
  const heroMk = totals.find((m) => m.id === heroId) || totals[0];
  const hh = evalSide(A.home, heroMk, tab, period), ha = evalSide(A.away, heroMk, tab, period);
  html += `<div class="card chart-card"><div class="chart-head"><h3>Total ${UNIT[tab]} per match · ${PERIODS[period]}</h3></div>
    <div class="line-chips">${totals.map((m) => `<button class="${m.id === heroMk.id ? "active" : ""}" data-action="hero" data-id="${m.id}">${tab === "corners" ? m.label.split(" ")[0] : "O" + m.line}</button>`).join("")}</div>
    <div class="chart-pair">
      <div><div class="chart-label">${crest(A.home.team)}<span>${esc(A.home.team.name)} · home</span><span class="k" style="color:${colorOf(hh)}">${hh.hits}/${hh.n}</span></div>${barChart(chartItemsFor(hh), heroMk.line, { aria: heroMk.label })}</div>
      <div><div class="chart-label">${crest(A.away.team)}<span>${esc(A.away.team.name)} · away</span><span class="k" style="color:${colorOf(ha)}">${ha.hits}/${ha.n}</span></div>${barChart(chartItemsFor(ha), heroMk.line, { aria: heroMk.label })}</div>
    </div>
    <div class="legend"><span><i style="background:#1ee38b"></i>Over the line</span><span><i style="background:#ff4f6d"></i>Under</span><span><i style="background:#2c3632"></i>No data</span><span>Oldest → newest</span></div></div>`;
  // Market table
  html += `<div class="section-title"><h2>${TAB_NAMES[tab]} · ${PERIODS[period]}</h2><span class="aside">Tap a row for the matches</span></div>`;
  html += `<div class="mkt-head"><span>Market</span><span class="c">${crest(A.home.team)}<span>Home</span></span><span class="c">${crest(A.away.team)}<span>Away</span></span><span class="c"><span>Combined</span></span></div>`;
  html += `<div class="card mkt">`;
  for (const item of MARKETS[tab]) {
    if (item.group) { html += `<div class="group-label">${item.group}</div>`; continue; }
    const r = rows.find((x) => x.mk.id === item.id);
    const pooledN = r.h.n + r.a.n, pooled = pooledN ? (100 * (r.h.hits + r.a.hits)) / pooledN : null;
    html += `<button class="mkt-row" data-action="market" data-id="${item.id}"><div class="mkt-name">${esc(item.label)}${item.metric === "team" || item.metric === "opp" ? `<small>${item.metric === "team" ? "each team, own sample" : "opponents of each team"}</small>` : ""}</div>
      ${pill(r.h)}${pill(r.a)}<div class="pill both ${rateClass(pooled, pooledN)}"><span class="p">${fmtPct(pooled)}</span><span class="f">${pooledN ? `${r.h.hits + r.a.hits}/${pooledN}` : ""}</span></div></button>`;
  }
  html += `</div>`;
  html += `<div class="note card small">“Combined” pools both samples (up to 20 matches). It is a <b>historical hit rate, not a prediction</b> or probability.</div>`;
  if (tab === "cards") html += cardRulesNote(true);
  if (tab === "goals" && period !== "FT") html += `<div class="note card small">Half-time scores: football-data.org's official HT score is used when it verified the same match; otherwise the HT score is rebuilt from PitchAPI's goal timeline (only if it reconciles exactly with the final score). 2nd-half goals = full-time minus half-time.</div>`;
  html += `<div class="footer">Data: PitchAPI${A.fdEnabled ? " · football-data.org" : ""} · Analysis generated ${fmtTime(A.generatedAt)}<br>${esc(A.rule)}</div>`;
  el.innerHTML = html;
}

function colorOf(res) { const c = rateClass(res.pct, res.n); return c === "g" ? "#1ee38b" : c === "a" ? "#ffb84d" : c === "r" ? "#ff4f6d" : "#5d6862"; }
function pill(res) {
  if (res.n === 0 && res.pending) return `<div class="pill load"><span class="p">···</span><span class="f">loading</span></div>`;
  const cls = rateClass(res.pct, res.n);
  return `<div class="pill ${cls}${res.pending ? " load" : ""}"><span class="p">${fmtPct(res.pct)}</span><span class="f">${res.n ? `${res.hits}/${res.n}` : "no data"}</span></div>`;
}
function chartItemsFor(res) {
  return res.rows.slice().reverse().map((r) => {
    const opp = res.side === "home" ? r.m.away : r.m.home; // samples are strictly home-only or away-only
    return { value: r.v ? r.x : null, hit: r.hit, label: short3(opp.name), sub: new Date(r.m.time).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", timeZone: tz }) };
  });
}

function cardRulesNote(collapsible) {
  const body = `<ul>
    <li><b>Source:</b> PitchAPI match events. Each <code>yellowcard</code> event = 1 yellow; each <code>redcard</code> event = 1 red. PitchAPI states a red card event covers straight reds <b>and</b> second yellows.</li>
    <li><b>Count used here:</b> cards = yellows + reds as recorded. A player sent off for two yellows therefore normally counts as 1 yellow + 1 red = 2 cards.</li>
    <li><b>Time:</b> regular time only (incl. stoppage time). Extra time and penalty shoot-outs are excluded. Halves are split by the minute of the card (45+ = 1st half).</li>
    <li><b>Not documented by the provider:</b> whether cards shown to managers/staff or after the final whistle are included.</li>
    <li><b>Bookmakers differ:</b> some count a second-yellow dismissal as 1 card, some as 2, some use booking points (e.g. 10 per yellow, 25 per red). Always check your bookmaker's rules — these figures are not settlement-equivalent.</li>
    <li>If a match's timeline is missing, it's excluded and shown as “no data” rather than counted as zero.</li></ul>`;
  return collapsible ? `<details class="note card"><summary>${ICON.alert.replace("<svg", '<svg width="16" height="16"')} How cards are counted</summary>${body}</details>` : `<div class="note card"><b>How cards are counted</b>${body}</div>`;
}

// ---------- Transparency sheet ----------
function openMarket(id) {
  const A = S.analysis; if (!A) return;
  const tab = S.tab, period = S.period;
  const mk = MARKETS[tab].find((m) => m.id === id); if (!mk) return;
  const sides = [A.home, A.away];
  let html = `<div class="grab"><i></i><div class="sheet-title"><div style="flex:1"><h3>${esc(mk.label)}</h3><p>${PERIODS[period]} · ${TAB_NAMES[tab]} · line ${mk.line}</p></div><button class="icon-btn" data-action="closeSheet" aria-label="Close">✕</button></div></div>`;
  for (const side of sides) {
    const res = evalSide(side, mk, tab, period);
    const t = side.side === "home" ? 0 : 1;
    html += `<div class="card side-block"><div class="side-head">${crest(side.team)}<div class="t"><b>${esc(side.team.name)}</b><span>Last ${side.sample.length} ${side.side.toUpperCase()} matches${side.sample.length < 10 ? " (only " + side.sample.length + " available)" : ""}</span></div>
      <div class="big" style="color:${colorOf(res)}">${fmtPct(res.pct)}<small>${res.hits}/${res.n}${res.n < res.sampleSize ? ` · ${res.sampleSize - res.n} excluded` : ""}</small></div></div>
      <div style="margin-top:10px">${barChart(chartItemsFor(res), mk.line, { h: 140, aria: mk.label })}</div>`;
    for (const r of res.rows) html += matchRow(r, t, tab, period, mk);
    if (!side.sample.length) html += `<p class="muted small">No completed ${side.side} matches found for this team in this competition (seasons checked: ${esc((side.seasonsScanned || []).join(", "))}).</p>`;
    html += `</div>`;
  }
  html += `<p class="dim small" style="margin-top:12px">Every row above is a real completed match. ✓ = market won, ✗ = lost, – = excluded (no data, never counted as a loss).</p>`;
  const sh = $("#sheet"); sh.innerHTML = html; sh.scrollTop = 0;
  sh.classList.add("open"); $("#scrim").classList.add("open");
}
function closeSheet() { $("#sheet").classList.remove("open"); $("#scrim").classList.remove("open"); }

function matchRow(r, t, tab, period, mk) {
  const m = r.m, d = r.d;
  const g = goalsFor(m, d);
  const ftTxt = m.score ? `${m.score[0]}-${m.score[1]}` : "";
  const htTxt = g.ht ? `HT ${g.ht[0]}-${g.ht[1]}` : "HT n/a";
  const me0 = t === 0, me1 = t === 1;
  let badge = "";
  if (m.fd?.status === "verified") badge = `<span class="badge ok" title="football-data.org matched this fixture and score">FD ✓</span>`;
  else if (m.fd?.status === "score_mismatch") badge = `<span class="badge warn" title="football-data.org has a different score">FD ≠ ${m.fd.ft ? m.fd.ft.join("-") : ""}</span>`;
  let val = "", res;
  if (r.v) {
    let sub = "";
    if (tab === "cards" && r.cards) sub = `${r.cards.y[0] + r.cards.y[1]}Y ${r.cards.r[0] + r.cards.r[1]}R`;
    else if (mk.metric === "total") sub = `${r.v[0]}+${r.v[1]}`;
    else sub = mk.metric === "team" ? "team" : mk.metric === "opp" ? "opp" : `${r.v[0]} & ${r.v[1]}`;
    val = `${r.x}<small>${sub}</small>`;
    res = `<span class="res ${r.hit ? "w" : "l"}">${r.hit ? "✓" : "✗"}</span>`;
  } else { val = `<small style="color:var(--dim)">n/a</small>`; res = `<span class="res x">–</span>`; }
  const flags = [];
  if (!r.v && r.missing && !r.pending) flags.push(r.missing);
  if (g.conflict) flags.push(`PitchAPI events give HT ${d.ht.join("-")}; official football-data.org HT used`);
  const rel = tab === "goals" ? /extra time|goal events/i : tab === "corners" ? /corner|extra time|team stats/i : /card|extra time|no events|events request/i;
  if (d && d.flags) for (const x of d.flags) if (rel.test(x) && !flags.includes(x)) flags.push(x);
  const extra = tab === "cards" && r.cards ? ` · ${r.cards.y[0]}Y${r.cards.r[0] ? " " + r.cards.r[0] + "R" : ""} – ${r.cards.y[1]}Y${r.cards.r[1] ? " " + r.cards.r[1] + "R" : ""}` : tab === "corners" && r.v ? ` · corners ${r.v[0]}-${r.v[1]}` : "";
  return `<div class="mrow"><div class="dt">${fmtShortDate(m.time)}</div>
    <div class="fx"><div class="ln ${me0 ? "me" : ""}"><span>${esc(m.home.name)}</span><span class="sc">${m.score ? m.score[0] : ""}</span></div>
    <div class="ln ${me1 ? "me" : ""}"><span>${esc(m.away.name)}</span><span class="sc">${m.score ? m.score[1] : ""}</span></div>
    <div class="ht">FT ${ftTxt} · ${htTxt}${g.htSrc ? ` (${g.htSrc === "football-data.org" ? "official" : "events"})` : ""}${extra}${badge} · <span class="dim">${esc(m.id)}</span></div>
    ${flags.length ? `<div class="flags">${flags.map(esc).join(" · ")}</div>` : ""}</div>
    <div class="val">${val}</div>${res}</div>`;
}

// ---------- Search ----------
async function viewSearch() {
  setNav("search");
  app().innerHTML = `<div class="search">${ICON.ball.replace("<svg", '<svg width="18" height="18"')}<input id="q" placeholder="Search a team or league…" autocomplete="off" value="${esc(S.lastQ || "")}"></div><div id="sRes" style="margin-top:10px">${skeleton(4)}</div>`;
  const input = $("#q");
  input.addEventListener("input", () => { S.lastQ = input.value; renderSearch(); });
  try { await loadComps(); await loadFixtures("ALL"); } catch (e) { $("#sRes").innerHTML = errorBox(e, "reload"); return; }
  if (S.route === "search") { renderSearch(); input.focus(); }
}
function renderSearch() {
  const el = $("#sRes"); if (!el) return;
  const q = (S.lastQ || "").trim().toLowerCase();
  const all = S.fixtures.ALL ? S.fixtures.ALL.list : [];
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const list = !q ? all.slice(0, 30) : all.filter((f) => {
    const comp = (S.comps || []).find((c) => c.code === f.comp);
    return [f.home.name, f.away.name, comp?.name || "", comp?.short || ""].some((s) => fold(s).includes(fold(q)));
  });
  el.innerHTML = (!q ? `<div class="section-title"><h2>Next up across all leagues</h2></div>` : `<div class="section-title"><h2>${list.length} fixture${list.length === 1 ? "" : "s"}</h2></div>`) + fixtureList(list, true);
}

// ---------- Favourites ----------
async function viewFavs() {
  setNav("favourites");
  const teams = Object.values(S.favTeams);
  let html = `<div class="section-title"><h2>Favourite leagues</h2><span class="aside">Tap to pin</span></div>`;
  app().innerHTML = html + skeleton(1, 40) + skeleton(3);
  try { await loadComps(); } catch (e) { app().innerHTML = errorBox(e, "reload"); return; }
  html += `<div class="chips">${S.comps.map((c) => `<button class="chip ${S.favComps.includes(c.code) ? "active" : ""}" data-action="favComp" data-code="${c.code}">${compLogo(c)}${esc(c.name)}</button>`).join("")}</div>`;
  html += `<div class="section-title"><h2>Favourite teams</h2></div>`;
  if (!teams.length) html += `<div class="card empty">${ICON.starO.replace("<svg", '<svg width="40" height="40"')}<h3>No favourite teams yet</h3><p>Open any fixture and tap the ☆ under a team.</p></div>`;
  else html += `<div class="chips">${teams.map((t) => `<button class="chip" data-action="unfav" data-id="${esc(t.id)}">${crest(t)}${esc(t.name)} ✕</button>`).join("")}</div><div class="section-title"><h2>Their upcoming fixtures</h2></div><div id="favFx">${skeleton(3)}</div>`;
  app().innerHTML = html;
  if (!teams.length) return;
  try {
    const all = await loadFixtures("ALL");
    if (S.route !== "favourites") return;
    const mine = all.filter((f) => S.favTeams[f.home.id] || S.favTeams[f.away.id]);
    $("#favFx").innerHTML = fixtureList(mine, true);
  } catch (e) { $("#favFx").innerHTML = errorBox(e, "reload"); }
}

// ---------- Data servers ----------
const PROVIDERS = [
  { id: "pitch", name: "PitchAPI", required: true, get: "https://pitchapi.dev/get-api-key", site: "pitchapi.dev", placeholder: "pk_live_…",
    role: "Matches, results back to 2021, corners by half, cards and goal timelines." },
  { id: "fd", name: "football-data.org", required: false, get: "https://www.football-data.org/client/register", site: "football-data.org", placeholder: "your token",
    role: "Optional. Official half-time scores and a second check on each result (current season)." },
];

async function viewSources() {
  setNav("sources");
  const k = store.get("keys", {});
  app().innerHTML = `<div class="card hero" style="margin-top:2px"><h1 style="font-size:27px">Data servers</h1><p>Connect a server once — matches, corners and cards then flow in automatically. Keys are stored only on this phone.</p></div>
  <div class="section-title"><h2>Your servers</h2><span class="aside" id="chkAt"></span></div>
  ${PROVIDERS.map((p) => `<div class="card provider">
    <div class="ph"><span class="dot ${k[p.id] ? "" : "off"}" id="dot-${p.id}"></span><b>${p.name}</b><span class="tag ${p.required ? "req" : ""}">${p.required ? "Required" : "Optional"}</span></div>
    <div class="role">${esc(p.role)}</div>
    <div class="field"><label for="key-${p.id}">API key</label><input id="key-${p.id}" placeholder="${p.placeholder}" value="${esc(k[p.id] || "")}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
    <div class="field"><div class="row"><button class="btn primary" data-action="connect" data-id="${p.id}" style="flex:1">${k[p.id] ? "Save & re-test" : "Connect"}</button>${k[p.id] ? `<button class="btn" data-action="disconnect" data-id="${p.id}">Disconnect</button>` : ""}</div></div>
    <div class="st" id="st-${p.id}">${k[p.id] ? `<span class="muted">Testing connection…</span>` : `Not connected · <a href="${p.get}" target="_blank" rel="noopener">get a free key at ${p.site}</a>`}</div>
  </div>`).join("")}
  <div class="section-title"><h2>Leagues</h2><span class="aside">Server league used for each</span></div><div id="mapTbl" class="card">${k.pitch ? skeleton(1, 120) : `<p class="muted small" style="padding:12px 14px;margin:0">Connect PitchAPI to see the leagues.</p>`}</div>
  <div class="section-title"><h2>What each statistic comes from</h2></div>
  <div class="card" style="overflow-x:auto"><table class="table"><tr><th>Statistic</th><th>Server</th><th>Periods</th></tr>
    <tr><td>Fixtures, results, history</td><td>PitchAPI (2021 →)</td><td>—</td></tr>
    <tr><td>Full-time goals</td><td>PitchAPI final score<br><span class="dim">checked against football-data.org when connected</span></td><td><span class="ok-t">FT</span></td></tr>
    <tr><td>Half-time goals</td><td>football-data.org official HT, or PitchAPI goal timeline (only if it adds up to the final score)</td><td><span class="ok-t">1H · 2H</span></td></tr>
    <tr><td>Corners</td><td>PitchAPI team stats</td><td><span class="ok-t">1H · 2H · FT</span></td></tr>
    <tr><td>Cards (Y / R)</td><td>PitchAPI card events</td><td><span class="ok-t">1H · 2H · FT</span></td></tr>
    <tr><td>Referee</td><td>PitchAPI</td><td>Name only</td></tr>
  </table></div>
  ${cardRulesNote(false)}
  <div class="section-title"><h2>Check raw server data</h2></div>
  <div class="card provider"><p class="muted small" style="margin:0">Every match row shows its ID (like <code>m_ab12CD</code>). Paste one here to see exactly what PitchAPI sent.</p>
    <div class="field"><div class="row"><input id="rawId" placeholder="m_xxxxxx" autocapitalize="off" autocorrect="off" spellcheck="false"><button class="btn" data-action="raw" data-part="stats">Stats</button><button class="btn" data-action="raw" data-part="events">Events</button></div></div><div id="rawOut"></div></div>
  <div class="section-title"><h2>Phone storage</h2></div>
  <div class="card provider"><p class="muted small" style="margin:0">Finished matches are saved on this phone so they open instantly. Fixtures and samples refresh each time you open the app or tap refresh.</p><div class="field"><button class="btn block" data-action="clearCache">Clear saved match data</button></div></div>
  <div class="footer">Football data provided by PitchAPI and the Football-Data.org API. Club names and crests belong to their owners and are shown for identification only. Historical statistics — not betting advice. 18+ · BeGambleAware.org</div>`;
  if (k.pitch || k.fd) runSourceCheck();
}

async function runSourceCheck() {
  try {
    const d = await api("sources");
    if (S.route !== "sources") return;
    $("#chkAt").textContent = "Checked " + fmtTime(d.checkedAt);
    for (const p of d.providers) {
      const dot = $("#dot-" + p.id), st = $("#st-" + p.id); if (!dot || !st) continue;
      if (!p.keyConfigured) continue;
      dot.className = "dot " + (p.ok ? "ok" : "bad");
      st.innerHTML = p.ok ? `<span class="ok-t">Connected</span> · ${esc(p.detail || "")}${p.latencyMs ? ` · ${p.latencyMs} ms` : ""}${p.id === "pitch" ? ` · <a href="#/">See matches →</a>` : ""}`
        : `<span class="bad-t">Couldn't connect:</span> ${esc(p.error)}${p.hint ? `<div class="warn-t" style="margin-top:4px;font-weight:600">${esc(p.hint)}</div>` : ""}`;
    }
    const map = $("#mapTbl");
    if (map && d.competitions && d.competitions.length) {
      const opts = [...d.pitchLeagues].sort((x, y) => x.name.localeCompare(y.name));
      map.innerHTML = `<table class="table"><tr><th>League</th><th>Server league</th></tr>${d.competitions.map((c) => `<tr><td><b>${esc(c.name)}</b><br>${c.resolved ? `<span class="ok-t small">${c.how === "override" ? "Picked by you" : "Matched automatically"}</span>` : `<span class="bad-t small">Needs picking</span>`}</td>
        <td><select data-action="mapLeague" data-code="${c.code}"><option value="">${c.resolved && c.how !== "override" ? "Automatic: " + esc(c.leagueName) + (c.leagueCC ? " (" + esc(c.leagueCC) + ")" : "") : "Automatic"}</option>${opts.map((l) => `<option value="${esc(l.id)}" ${c.how === "override" && c.leagueId === l.id ? "selected" : ""}>${esc(l.name)}${l.cc ? " (" + esc(l.cc) + ")" : ""}</option>`).join("")}</select></td></tr>`).join("")}</table>`;
    } else if (map && store.get("keys", {}).pitch) map.innerHTML = `<p class="muted small" style="padding:12px 14px;margin:0">Leagues appear once PitchAPI connects.</p>`;
  } catch (e) { const st = $("#st-pitch"); if (st) st.innerHTML = `<span class="bad-t">${esc(e.message)}</span>`; }
}

// ---------------------------------------------------------------------
// Router + events
// ---------------------------------------------------------------------
function route() {
  closeSheet();
  const h = location.hash.replace(/^#\/?/, "");
  const parts = h.split("/");
  window.scrollTo(0, 0);
  if (parts[0] === "match" && parts[1] && parts[2]) { S.route = "match"; return viewMatch(parts[1], parts[2]); }
  if (parts[0] === "search") { S.route = "search"; return viewSearch(); }
  if (parts[0] === "favourites") { S.route = "favourites"; return viewFavs(); }
  if (parts[0] === "sources") { S.route = "sources"; return viewSources(); }
  S.route = "home"; return viewHome();
}

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-action]"); if (!b) return;
  const a = b.dataset.action;
  if (a === "comp") {
    S.comp = b.dataset.code; store.set("lastComp", S.comp);
    document.querySelectorAll(".chip[data-action=comp]").forEach((c) => c.classList.toggle("active", c.dataset.code === S.comp));
    $("#fxWrap").innerHTML = skeleton(5);
    try { const list = await loadFixtures(S.comp); $("#fxWrap").innerHTML = fixtureList(list, false); $("#hsFix") && ($("#hsFix").textContent = list.length); }
    catch (e) { $("#fxWrap").innerHTML = errorBox(e, "reload"); }
  } else if (a === "tab") { S.tab = b.dataset.tab; store.set("tab", S.tab); document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("active", x.dataset.tab === S.tab)); renderMatchBody(); }
  else if (a === "period") { S.period = b.dataset.period; store.set("period", S.period); document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("active", x.dataset.period === S.period)); renderMatchBody(); }
  else if (a === "hero") { S.hero[S.tab] = b.dataset.id; renderMatchBody(); }
  else if (a === "market") openMarket(b.dataset.id);
  else if (a === "closeSheet") closeSheet();
  else if (a === "favTeam") {
    const t = S.analysis.fixture[b.dataset.side];
    if (S.favTeams[t.id]) { delete S.favTeams[t.id]; toast("Removed from favourites"); } else { S.favTeams[t.id] = t; toast("★ Added to favourites"); }
    store.set("favTeams", S.favTeams); renderMatch();
  } else if (a === "unfav") { delete S.favTeams[b.dataset.id]; store.set("favTeams", S.favTeams); viewFavs(); }
  else if (a === "favComp") {
    const c = b.dataset.code; S.favComps = S.favComps.includes(c) ? S.favComps.filter((x) => x !== c) : [...S.favComps, c];
    store.set("favComps", S.favComps); b.classList.toggle("active");
  } else if (a === "connect" || a === "disconnect") {
    const id = b.dataset.id, keys = store.get("keys", {});
    if (a === "connect") {
      const v = ($("#key-" + id).value || "").trim();
      if (!v) { toast("Paste your key first"); return; }
      keys[id] = v; toast("Connecting…");
    } else { delete keys[id]; toast("Disconnected"); }
    store.set("keys", keys);
    window.Engine.refresh(); S.comps = null; S.fixtures = {}; S.analysis = null;
    viewSources();
  }
  else if (a === "clearCache") {
    for (const id of store.get("mIndex", [])) store.del("m:" + id);
    store.del("mIndex"); S.details.clear(); toast("Saved match data cleared");
  } else if (a === "raw") {
    const id = $("#rawId").value.trim(), out = $("#rawOut");
    out.innerHTML = skeleton(1, 80);
    try { const d = await api(`raw?id=${encodeURIComponent(id)}&part=${b.dataset.part}`); out.innerHTML = `<p class="dim small">${esc(d.endpoint)}</p><pre class="raw">${esc(JSON.stringify(d.data, null, 2))}</pre>`; }
    catch (e) { out.innerHTML = `<p class="bad-t small">${esc(e.message)}</p>`; }
  } else if (a === "reload") route();
});

$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
document.addEventListener("change", (ev) => {
  const sel = ev.target.closest("select[data-action=mapLeague]"); if (!sel) return;
  window.Engine.setLeagueOverride(sel.dataset.code, sel.value);
  window.Engine.refresh(); S.comps = null; S.fixtures = {}; S.analysis = null;
  toast(sel.value ? "League updated" : "Back to automatic"); runSourceCheck();
});
$("#refreshBtn").addEventListener("click", async () => {
  const b = $("#refreshBtn"); b.classList.add("spin");
  window.Engine.refresh();
  S.fixtures = {}; S.comps = null; S.analysis = null;
  await route(); b.classList.remove("spin"); toast("Data refreshed");
});
window.addEventListener("hashchange", route);
route();

// No service worker needed: inside the Android app everything is bundled.
