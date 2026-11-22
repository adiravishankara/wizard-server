"use strict";
/* Wizard web client: lobby, live game, teams, leagues. */

const API = "/api/game";
const LAPI = "/api/league";

const S = {
  session: null,      // {game_id, player_id, token, name}
  state: null,        // PlayerState from server
  ws: null,
  wsRetry: null,
  draftTeams: [],     // lobby team editor: [{id, name, color, player_indices, league_team_id}]
  draftLeagueId: null,
  bidVal: 0,
  selected: null,     // hand index pending confirm
  league: null,       // open league detail
};

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

async function api(path, method = "GET", body = null) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}
const gapi = (p, m, b) => api(API + p, m, b);
const lapi = (p, m, b) => api(LAPI + p, m, b);

function alertMsg(msg, ok = false) {
  const el = $("game-alert");
  el.textContent = msg;
  el.classList.toggle("success", ok);
  el.classList.remove("hidden");
  clearTimeout(alertMsg.t);
  alertMsg.t = setTimeout(() => el.classList.add("hidden"), 5000);
}

function sessionKey(s) {
  return `${s.game_id}:${s.player_id}`;
}
function getSessions() {
  try { return JSON.parse(localStorage.getItem("wizard_sessions") || "[]"); }
  catch { return []; }
}
function saveSession(sess) {
  const all = getSessions().filter((s) => sessionKey(s) !== sessionKey(sess));
  all.unshift(sess);
  localStorage.setItem("wizard_sessions", JSON.stringify(all.slice(0, 12)));
  try { sessionStorage.setItem("wizard_active", JSON.stringify(sess)); } catch { /* ignore */ }
}
function removeSession(sess) {
  const key = typeof sess === "string" ? sess : sessionKey(sess);
  localStorage.setItem("wizard_sessions",
    JSON.stringify(getSessions().filter((s) => sessionKey(s) !== key)));
}

/* ---------- navigation ---------- */
function showView(which) {
  $("view-games").classList.toggle("hidden", which !== "games");
  $("view-leagues").classList.toggle("hidden", which !== "leagues");
  $("nav-games").classList.toggle("active", which === "games");
  $("nav-leagues").classList.toggle("active", which === "leagues");
  if (which === "leagues") loadLeaguesHome();
}
$("nav-games").onclick = () => showView("games");
$("nav-leagues").onclick = () => showView("leagues");

const THEME_KEY = "wizard_theme";
function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(pref) {
  const resolved = pref === "system" ? systemTheme() : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-pref", pref);
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* ignore */ }
  ["light", "dark", "system"].forEach((name) => {
    const btn = $(`theme-${name}`);
    if (btn) btn.classList.toggle("active", pref === name);
  });
}
function initTheme() {
  let pref = "light";
  try { pref = localStorage.getItem(THEME_KEY) || "light"; } catch { /* ignore */ }
  if (!["light", "dark", "system"].includes(pref)) pref = "light";
  applyTheme(pref);
  ["light", "dark", "system"].forEach((name) => {
    const btn = $(`theme-${name}`);
    if (btn) btn.onclick = () => applyTheme(name);
  });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSys = () => {
    if (document.documentElement.getAttribute("data-theme-pref") === "system") applyTheme("system");
  };
  if (mq.addEventListener) mq.addEventListener("change", onSys);
  else if (mq.addListener) mq.addListener(onSys);
}
initTheme();

/* ---------- games home ---------- */
$("btn-create").onclick = async () => {
  const name = $("new-name").value.trim();
  if (!name) return alertMsg("Enter your name first.");
  try {
    const r = await gapi("/join", "POST", {
      name, bidding_mode: $("new-bidding").value,
    });
    enterGame({ game_id: r.game_id, player_id: r.player_id, token: r.token, name });
  } catch (e) { alertMsg(e.message); }
};

$("btn-join").onclick = async () => {
  const code = $("join-code").value.trim();
  const name = $("join-name").value.trim();
  if (!code || !name) return alertMsg("Enter a game code and your name.");
  try {
    const r = await gapi("/join", "POST", { name, game_id: code });
    enterGame({ game_id: r.game_id, player_id: r.player_id, token: r.token, name });
  } catch (e) { alertMsg(e.message); }
};

function renderSessions() {
  const list = $("sessions-list");
  const all = getSessions();
  if (!all.length) { list.innerHTML = `<div class="empty">No sessions yet.</div>`; return; }
  list.innerHTML = all.map((s) => `
    <div class="session-row">
      <div><code>${esc(s.game_id)}</code> <span class="hint">${esc(s.name)}</span></div>
      <div class="row" style="margin:0">
        <button data-resume="${esc(sessionKey(s))}">Resume</button>
        <button data-forget="${esc(sessionKey(s))}" class="ghost">✕</button>
      </div>
    </div>`).join("");
  list.querySelectorAll("[data-resume]").forEach((b) =>
    b.onclick = () => {
      const s = getSessions().find((x) => sessionKey(x) === b.dataset.resume);
      if (s) resumeSession(s);
    });
  list.querySelectorAll("[data-forget]").forEach((b) =>
    b.onclick = () => { removeSession(b.dataset.forget); renderSessions(); });
}

async function resumeSession(sess) {
  try {
    const r = await gapi("/rejoin", "POST", { game_id: sess.game_id, token: sess.token });
    enterGame({
      game_id: r.game_id,
      player_id: r.player_id,
      token: sess.token,
      name: r.name,
    });
  } catch (e) {
    alertMsg(e.message);
    const msg = String(e.message || "");
    if (/not found|invalid session/i.test(msg)) {
      removeSession(sess);
      renderSessions();
    }
  }
}

/* ---------- game screen ---------- */
function enterGame(sess) {
  S.session = sess;
  S.selected = null;
  saveSession(sess);
  S.draftTeams = [];
  S.draftLeagueId = null;
  $("games-home").classList.add("hidden");
  $("game-screen").classList.remove("hidden");
  $("g-code").textContent = sess.game_id;
  connectWS();
  loadGameTeams();
  refreshLeagueSelects();
}

$("btn-leave").onclick = () => {
  const leaving = S.ws;
  S.session = null; S.state = null;
  clearTimeout(S.wsRetry);
  S.wsRetry = null;
  if (leaving) {
    leaving.onclose = null;
    leaving.close();
  }
  S.ws = null;
  S.prevTrick = null;
  S.trickKeys = null;
  openScores(false);
  try { sessionStorage.removeItem("wizard_active"); } catch { /* ignore */ }
  $("game-screen").classList.add("hidden");
  $("games-home").classList.remove("hidden");
  renderSessions();
};

function connectWS() {
  if (!S.session) return;
  const { game_id, player_id } = S.session;
  clearTimeout(S.wsRetry);
  S.wsRetry = null;
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${API}/ws/${game_id}/${player_id}`);
  S.ws = ws;
  ws.onmessage = (ev) => {
    try {
      S.state = JSON.parse(ev.data);
      renderGame();
    } catch { /* ignore */ }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    clearTimeout(S.wsRetry);
    S.wsRetry = setTimeout(() => {
      if (S.session) { alertMsg("Connection lost — reconnecting…"); connectWS(); }
    }, 3000);
  };
  ws.onerror = () => { if (S.ws === ws) ws.close(); };
}

/* ----- cards ----- */
const SUIT_SYM = { H: "♥", D: "♦", C: "♣", S: "♠" };
const SUIT_NAME = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const MAX_ROUNDS = { 3: 20, 4: 15, 5: 12, 6: 10 };
const isRedSuit = (s) => s === "H" || s === "D";
function rankLabel(r) {
  return r === 11 ? "J" : r === 12 ? "Q" : r === 13 ? "K" : r === 14 ? "A" : String(r);
}

// Pip centres as % of the pip box (0 = top/left edge of the box).
const PIP_LAYOUT = {
  2: [[50, 0], [50, 100]],
  3: [[50, 0], [50, 50], [50, 100]],
  4: [[0, 0], [100, 0], [0, 100], [100, 100]],
  5: [[0, 0], [100, 0], [50, 50], [0, 100], [100, 100]],
  6: [[0, 0], [100, 0], [0, 50], [100, 50], [0, 100], [100, 100]],
  7: [[0, 0], [100, 0], [50, 25], [0, 50], [100, 50], [0, 100], [100, 100]],
  8: [[0, 0], [100, 0], [50, 25], [0, 50], [100, 50], [50, 75], [0, 100], [100, 100]],
  9: [[0, 0], [100, 0], [0, 33.3], [100, 33.3], [50, 50], [0, 66.7], [100, 66.7], [0, 100], [100, 100]],
  10: [[0, 0], [100, 0], [50, 16.7], [0, 33.3], [100, 33.3], [0, 66.7], [100, 66.7], [50, 83.3], [0, 100], [100, 100]],
};
const COURT_ART = {
  13: `<svg viewBox="0 0 40 26" aria-hidden="true"><path d="M3 21 L6 6 L13 14 L20 3 L27 14 L34 6 L37 21 Z" fill="currentColor" opacity=".88"/><circle cx="6" cy="5" r="2" fill="currentColor"/><circle cx="20" cy="2.5" r="2" fill="currentColor"/><circle cx="34" cy="5" r="2" fill="currentColor"/><rect x="3" y="20" width="34" height="4" rx="1.2" fill="currentColor"/></svg>`,
  12: `<svg viewBox="0 0 40 26" aria-hidden="true"><path d="M5 21 Q20 1 35 21 Z" fill="currentColor" opacity=".82"/><circle cx="20" cy="6" r="3" fill="currentColor"/><circle cx="11" cy="13" r="2" fill="currentColor"/><circle cx="29" cy="13" r="2" fill="currentColor"/><rect x="5" y="20" width="30" height="4" rx="1.2" fill="currentColor"/></svg>`,
  11: `<svg viewBox="0 0 40 26" aria-hidden="true"><path d="M6 21 Q8 8 20 7 Q32 8 34 21 Z" fill="currentColor" opacity=".82"/><path d="M25 8 Q33 0 39 3 Q33 6 30 12 Z" fill="currentColor"/><rect x="6" y="20" width="28" height="4" rx="1.2" fill="currentColor"/></svg>`,
};
const WIZARD_ART = `<svg viewBox="0 0 60 64" aria-hidden="true">
  <path d="M31 3 C34 15 40 31 47 48 L13 48 C20 33 26 18 31 3 Z" fill="#2a1f7a" stroke="#ffd96a" stroke-width="2"/>
  <ellipse cx="30" cy="50" rx="26" ry="7" fill="#ffd96a"/>
  <ellipse cx="30" cy="49" rx="18" ry="3.5" fill="#e9b93f"/>
  <path d="M27 26 l2.2 4.4 4.8.7-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8-3.5-3.4 4.8-.7z" fill="#ffe9a0"/>
  <path d="M36 15 a5 5 0 1 0 2.5 8.5 a4 4 0 1 1 -2.5 -8.5z" fill="#ffe9a0"/>
  <circle cx="31" cy="3.5" r="2.6" fill="#fff3c4"/>
</svg>`;
const JESTER_ART = `<svg viewBox="0 0 60 66" aria-hidden="true">
  <path d="M11 48 C9 35 5 26 3 18 C13 22 19 30 22 38 L22 48 Z" fill="#d6453d"/>
  <path d="M22 48 L22 38 C24 24 27 14 30 6 C33 14 36 24 38 38 L38 48 Z" fill="#2f9e6a"/>
  <path d="M38 48 L38 38 C41 30 47 22 57 18 C55 26 51 35 49 48 Z" fill="#e7a51b"/>
  <rect x="9" y="46" width="42" height="8" rx="3" fill="#7b3fb0"/>
  <circle cx="3" cy="18" r="3.6" fill="#f5c542" stroke="#8a6a12" stroke-width="1"/>
  <circle cx="30" cy="6" r="3.6" fill="#f5c542" stroke="#8a6a12" stroke-width="1"/>
  <circle cx="57" cy="18" r="3.6" fill="#f5c542" stroke="#8a6a12" stroke-width="1"/>
  <path d="M22 59 Q30 66 38 59" stroke="#7b3fb0" stroke-width="2.6" fill="none" stroke-linecap="round"/>
</svg>`;
const CROWN_SVG = `<svg class="crown" viewBox="0 0 24 16" aria-label="Leader"><path d="M2 14 L4 4 L9 9 L12 2 L15 9 L20 4 L22 14 Z" fill="#f5c542" stroke="#8a6a12" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

function cardHTML(card, opts = {}) {
  const cls = opts.cls || "";
  const attrs = opts.attrs || "";
  const style = opts.style ? ` style="${opts.style}"` : "";
  if (!card || card.type === "back") {
    return `<div class="pcard back ${cls}"${style} ${attrs}></div>`;
  }
  if (card.type === "wizard") {
    return `<div class="pcard wizard ${cls}"${style} ${attrs}><div class="stars"></div>
      <div class="idx tl"><span class="r">W</span></div>
      <div class="special-art">${WIZARD_ART}</div><div class="special-name">WIZARD</div>
      <div class="idx br"><span class="r">W</span></div></div>`;
  }
  if (card.type === "jester") {
    return `<div class="pcard jester ${cls}"${style} ${attrs}>
      <div class="idx tl"><span class="r">JE</span></div>
      <div class="special-art">${JESTER_ART}</div><div class="special-name">JESTER</div>
      <div class="idx br"><span class="r">JE</span></div></div>`;
  }
  const s = SUIT_SYM[card.suit] || "";
  const r = rankLabel(card.rank);
  let face;
  if (card.rank === 14) {
    face = `<div class="ace">${s}</div>`;
  } else if (card.rank >= 11) {
    face = `<div class="court">${COURT_ART[card.rank]}<span class="court-letter">${r}</span><span class="court-suit">${s}</span></div>`;
  } else {
    face = `<div class="pips">${(PIP_LAYOUT[card.rank] || []).map(([x, y]) =>
      `<span class="pip${y > 50 ? " flip" : ""}" style="left:${x}%;top:${y}%">${s}</span>`).join("")}</div>`;
  }
  const idx = `<span class="r">${esc(r)}</span><span class="s">${s}</span>`;
  return `<div class="pcard ${isRedSuit(card.suit) ? "red" : "black"} ${cls}"${style} ${attrs}>
    <div class="idx tl">${idx}</div>${face}<div class="idx br">${idx}</div></div>`;
}
function suitTileCard(suit, cls = "") {
  return `<div class="pcard suit-tile-card ${isRedSuit(suit) ? "red" : "black"} ${cls}"><div class="ace">${SUIT_SYM[suit]}</div></div>`;
}
function cardName(c) {
  if (!c) return "";
  if (c.type === "wizard") return "Wizard";
  if (c.type === "jester") return "Jester";
  return `${rankLabel(c.rank)}${SUIT_SYM[c.suit] || ""}`;
}

function layoutFan(container) {
  const cards = [...container.querySelectorAll(".pcard")];
  const n = cards.length;
  if (!n) return;
  const maxW = (container.clientWidth || 360) - 30;
  const w = cards[0].offsetWidth || 90;
  const step = n === 1 ? 0 : Math.min(w * 0.64, (maxW - w) / (n - 1));
  const mid = (n - 1) / 2;
  const spread = Math.min(3.4, 28 / n);
  cards.forEach((el, i) => {
    const d = i - mid;
    el.style.marginLeft = i === 0 ? "0px" : `${(step - w).toFixed(1)}px`;
    el.style.zIndex = String(i + 1);
    el.style.setProperty("--fr", `${(d * spread).toFixed(2)}deg`);
    el.style.setProperty("--fy", `${(d * d * spread * 0.45).toFixed(1)}px`);
  });
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  const a = (parts[0] || "?")[0] || "?";
  const b = parts.length > 1 ? parts[1][0] : (parts[0][1] || "");
  return (a + b).toUpperCase();
}
function avatarHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatarHTML(name) {
  return `<div class="avatar" style="--hue:${avatarHue(name)}">${esc(initials(name))}</div>`;
}
function playerBadge(st, i) {
  const name = st.players[i];
  const me = st.player_id === i;
  return `<div class="pbadge ${me ? "me" : ""}">
    ${avatarHTML(name)}
    <div><div class="pbadge-name">${esc(name)}${me ? " (you)" : ""}</div>
    <div class="pbadge-meta">Seat ${i + 1}</div></div>
  </div>`;
}

/* ----- table state helpers ----- */
function bidRaw(st, i) {
  const key = String(i);
  if (!Object.prototype.hasOwnProperty.call(st.bids || {}, key)) return undefined;
  return st.bids[key];
}
function isLeader(st, i) {
  if (!(st.history || []).length) return false;
  return st.scores[i] === Math.max(...st.scores);
}
function isTurn(st, i) {
  if (st.phase === "bidding" &&
      (st.bidding_mode === "simultaneous" || st.bidding_mode === "secret")) {
    return bidRaw(st, i) === undefined;
  }
  if (["bidding", "playing", "waiting_trump"].includes(st.phase)) return st.current_player === i;
  return false;
}
function trickWinner(st) {
  return st.trick_complete ? st.current_player : null;
}

function statusText(st) {
  const name = st.players[st.current_player] ?? "";
  const me = st.player_id === st.current_player;
  if (st.phase === "lobby") return "Waiting for players…";
  if (st.phase === "waiting_trump") {
    return me ? "Wizard flipped — choose trump" : `Wizard flipped — ${name} is choosing trump…`;
  }
  if (st.phase === "bidding") {
    const open = st.bidding_mode === "simultaneous" || st.bidding_mode === "secret";
    if (open) return bidRaw(st, st.player_id) === undefined ? "Your turn to bid" : "Waiting for others to bid…";
    return me ? "Your turn to bid" : `Waiting for ${name} to bid…`;
  }
  if (st.phase === "playing") {
    if (st.trick_complete) return me ? "You won the trick — your lead" : `${name} won the trick and leads next`;
    if (!st.current_trick.length) return me ? "Your lead" : `${name} leads…`;
    return me ? "Your turn to play" : `Waiting for ${name} to play…`;
  }
  if (st.phase === "round_over") {
    const ready = (st.ready || []).includes(st.player_id);
    return ready ? "Waiting for everyone to be ready…" : "Round over";
  }
  if (st.phase === "game_over") return "Game over";
  return "";
}

/* ----- seat geometry ----- */
const compactMQ = window.matchMedia("(max-width: 640px)");
const isCompact = () => compactMQ.matches;
function seatPos(k, n, compact) {
  if (compact) {
    if (k === 0) return { x: 50, y: 90 };
    const m = n - 1;
    const t = m === 1 ? 0.5 : (k - 1) / (m - 1);
    const span = m <= 2 ? 52 : 78;
    const x = 50 - span / 2 + span * t;
    const y = 12 + 10 * Math.pow(2 * t - 1, 2);
    return { x, y };
  }
  const th = (90 + (k * 360) / n) * Math.PI / 180;
  return { x: 50 + 43 * Math.cos(th), y: 50 + 41 * Math.sin(th) };
}
function trickPos(k, n, compact) {
  const s = seatPos(k, n, compact);
  if (compact) {
    // Opponent badges stack tall along the top on phones, so their cards sit in a low arc.
    if (k === 0) return { x: 50, y: 69 };
    return { x: 50 + (s.x - 50) * 0.74, y: 47 + (s.y - 12) * 0.5 };
  }
  return { x: 50 + (s.x - 50) * 0.4, y: 50 + (s.y - 50) * 0.4 };
}
const trickRot = (pi, order) => (((pi * 47 + order * 29) % 15) - 7);
const trickKey = (pi, c) => `${pi}:${c.type}:${c.suit || ""}:${c.rank || 0}`;

/* ----- table pieces ----- */
function seatStat(st, i) {
  const raw = bidRaw(st, i);
  if (st.phase === "lobby") return "";
  if (st.phase === "waiting_trump") return `<span class="seat-stat" title="Bid">–</span>`;
  if (st.phase === "bidding") {
    if (raw === undefined) return `<span class="seat-stat" title="Not bid yet">…</span>`;
    if (raw === null) return `<span class="seat-stat" title="Bid hidden">✓</span>`;
    return `<span class="seat-stat" title="Bid">${raw}<span class="lbl">bid</span></span>`;
  }
  const won = st.trick_wins[i] ?? 0;
  const bid = typeof raw === "number" ? raw : "?";
  let cls = "";
  if (typeof raw === "number") cls = won === raw ? "made" : (won > raw ? "over" : "");
  return `<span class="seat-stat ${cls}" title="Tricks won / bid">${won}/${bid}</span>`;
}
function trumpTileHTML(st) {
  if (st.phase === "waiting_trump") return `<div class="trump-tile none" title="Trump">?</div>`;
  if (st.trump_suit) {
    return `<div class="trump-tile ${isRedSuit(st.trump_suit) ? "red" : ""}" title="Trump: ${SUIT_NAME[st.trump_suit]}">${SUIT_SYM[st.trump_suit]}</div>`;
  }
  return `<div class="trump-tile none" title="No trump">NO<br>TRUMP</div>`;
}
function seatHTML(st, i, pos) {
  const name = st.players[i];
  const me = i === st.player_id;
  const winner = trickWinner(st) === i && st.phase === "playing";
  const ready = st.phase === "round_over" && (st.ready || []).includes(i);
  const cnt = (st.hand_counts || [])[i] ?? 0;
  const backs = me ? "" : `<div class="seat-backs" title="${cnt} card${cnt === 1 ? "" : "s"} in hand">${
    Array.from({ length: Math.min(cnt, 6) }, () => cardHTML(null)).join("")}<span class="count">${cnt}</span></div>`;
  const classes = ["seat", isTurn(st, i) ? "turn" : "", me ? "me" : "", winner ? "won" : "", ready ? "ready-in" : ""];
  return `<div class="${classes.join(" ")}" style="left:${pos.x.toFixed(2)}%;top:${pos.y.toFixed(2)}%" data-seat="${i}">
    <div class="seat-badge">
      <div class="avatar-wrap">${isLeader(st, i) ? CROWN_SVG : ""}${avatarHTML(name)}${
        i === st.dealer_idx ? `<span class="dealer-chip" title="Dealer">D</span>` : ""}</div>
      <div class="seat-info"><div class="seat-name">${esc(name)}</div><div class="seat-meta">${st.scores[i]} pts</div></div>
      <div class="seat-row2">${seatStat(st, i)}${backs}</div>
      ${me ? trumpTileHTML(st) : ""}
    </div></div>`;
}

function renderSeats(st, compact) {
  const n = st.players.length;
  $("seats").innerHTML = st.players.map((_, i) => {
    const k = (i - st.player_id + n) % n;
    return seatHTML(st, i, seatPos(k, n, compact));
  }).join("");
}

function renderTrumpSpot(st) {
  const el = $("trump-spot");
  const flip = st.flip || {};
  let flipped = "";
  if (flip.card) flipped = cardHTML(flip.card, { cls: "flipped" });
  else if (st.trump_suit) flipped = suitTileCard(st.trump_suit, "flipped");
  const chosen = flip.kind === "wizard" && st.trump_suit ? suitTileCard(st.trump_suit, "chosen") : "";
  let label;
  if (st.phase === "waiting_trump") label = "Wizard — choosing…";
  else if (st.trump_suit) {
    label = `Trump <span class="${isRedSuit(st.trump_suit) ? "red" : ""}">${SUIT_SYM[st.trump_suit]}</span>`;
  } else if (flip.kind === "jester") label = "Jester — no trump";
  else label = "No trump";
  el.innerHTML = `<div class="deck-row"><div class="deck">${cardHTML(null)}${cardHTML(null)}${cardHTML(null)}</div>${flipped}${chosen}</div>
    <div class="trump-label">${label}</div>`;
}

function roundSummaryHTML(st) {
  const h = (st.history || [])[st.history.length - 1];
  if (!h) return `<div class="center-title">Round over</div>`;
  const rows = st.players.map((p, i) => {
    const d = h.deltas[i];
    return `<div class="rs-row"><span>${esc(p)}</span>
      <span class="dim">${h.tricks[i]}/${h.bids[String(i)]}</span>
      <span class="delta ${d >= 0 ? "pos" : "neg"}">${d > 0 ? "+" : ""}${d}</span>
      <strong>${h.scores[i]}</strong></div>`;
  }).join("");
  return `<div class="round-summary"><h3>Round ${h.round} results</h3>${rows}</div>`;
}

function renderCenter(st) {
  const el = $("table-center");
  const n = st.players.length;
  let html = "";
  if (st.phase === "waiting_trump") {
    const mine = st.current_player === st.player_id;
    html = `${cardHTML((st.flip && st.flip.card) || { type: "wizard" }, { cls: "flip-big" })}
      <div class="center-title">Wizard flipped</div>
      <div class="center-sub">${mine ? "You choose trump" : `${esc(st.players[st.current_player])} is choosing trump…`}</div>`;
  } else if (st.phase === "bidding") {
    const placed = Object.keys(st.bids || {}).length;
    const total = Object.values(st.bids || {}).filter((b) => typeof b === "number").reduce((a, b) => a + b, 0);
    const open = st.bidding_mode !== "secret";
    html = `<div class="center-title">Round ${st.current_round} · ${st.current_round} card${st.current_round === 1 ? "" : "s"}</div>
      <div class="center-sub">${placed} of ${n} bid${open && placed ? ` · total ${total}` : ""}</div>`;
  } else if (st.phase === "playing" && !st.current_trick.length) {
    html = `<div class="center-sub">${st.current_player === st.player_id ? "Your lead" : `${esc(st.players[st.current_player])} leads`}</div>`;
  } else if (st.phase === "round_over") {
    html = roundSummaryHTML(st);
  }
  el.innerHTML = html;
}

function animateCollect(prev, compact) {
  const layer = $("trick-ghosts");
  const n = prev.n;
  const target = seatPos((prev.winner - prev.me + n) % n, n, compact);
  layer.innerHTML = prev.cards.map(([pi, c], order) => {
    const pos = trickPos((pi - prev.me + n) % n, n, compact);
    return cardHTML(c, {
      cls: "tcard",
      style: `left:${pos.x}%;top:${pos.y}%;z-index:${order + 1};--rot:${trickRot(pi, order)}deg`,
    });
  }).join("");
  const els = [...layer.children];
  void layer.offsetWidth;
  requestAnimationFrame(() => {
    els.forEach((el) => {
      el.style.left = `${target.x}%`;
      el.style.top = `${target.y}%`;
      el.classList.add("collecting");
    });
  });
  clearTimeout(animateCollect.t);
  animateCollect.t = setTimeout(() => { layer.innerHTML = ""; }, 650);
}

function renderTrick(st, compact) {
  const zone = $("trick-area");
  const n = st.players.length;
  const cards = st.phase === "playing" ? st.current_trick : [];
  const sig = cards.map(([pi, c]) => trickKey(pi, c)).join("|");
  const prev = S.prevTrick;
  if (prev && prev.complete && prev.sig !== sig) animateCollect(prev, compact);
  const W = $("table").clientWidth || 600;
  const H = $("table").clientHeight || 400;
  const seen = S.trickKeys || new Set();
  const fresh = new Set();
  const winner = trickWinner(st);
  zone.innerHTML = cards.map(([pi, c], order) => {
    const k = (pi - st.player_id + n) % n;
    const pos = trickPos(k, n, compact);
    const seat = seatPos(k, n, compact);
    const key = trickKey(pi, c);
    fresh.add(key);
    const dx = ((seat.x - pos.x) / 100) * W;
    const dy = ((seat.y - pos.y) / 100) * H;
    const cls = ["tcard", seen.has(key) ? "" : "landing", winner === pi ? "winner" : ""].join(" ");
    return cardHTML(c, {
      cls,
      style: `left:${pos.x.toFixed(2)}%;top:${pos.y.toFixed(2)}%;z-index:${order + 1};--rot:${trickRot(pi, order)}deg;--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px`,
      attrs: `title="${esc(st.players[pi])}: ${cardName(c)}"`,
    });
  }).join("");
  S.trickKeys = fresh;
  S.prevTrick = cards.length
    ? { cards: cards.slice(), sig, complete: !!st.trick_complete, winner: st.current_player, n, me: st.player_id }
    : null;
}

/* ----- main render ----- */
function renderGame() {
  const st = S.state;
  if (!st) return;
  const me = st.player_id;
  const n = st.players.length;
  const compact = isCompact();

  const maxR = MAX_ROUNDS[n];
  const shownRound = st.phase === "round_over" && (st.history || []).length
    ? st.history[st.history.length - 1].round : st.current_round;
  $("g-round").textContent = `${compact ? "Rd" : "Round"} ${shownRound}${maxR ? `/${maxR}` : ""}`;
  const trumpEl = $("g-trump");
  if (st.phase === "waiting_trump") {
    trumpEl.textContent = compact ? "Trump ?" : "Choosing trump";
    trumpEl.classList.remove("none");
  } else if (st.trump_suit) {
    trumpEl.innerHTML = `Trump <span class="${isRedSuit(st.trump_suit) ? "red" : ""}">${SUIT_SYM[st.trump_suit]}</span>`;
    trumpEl.classList.remove("none");
  } else {
    trumpEl.textContent = "No trump";
    trumpEl.classList.add("none");
  }
  const isLobby = st.phase === "lobby";
  const over = st.phase === "game_over";
  $("g-round").classList.toggle("hidden", isLobby);
  trumpEl.classList.toggle("hidden", isLobby || over);
  $("btn-scores").classList.toggle("hidden", isLobby);
  $("status-line").textContent = statusText(st);

  $("lobby-panel").classList.toggle("hidden", !isLobby);
  $("table-panel").classList.toggle("hidden", isLobby || over);
  if (isLobby) renderLobby(st);

  if (!isLobby && !over) {
    renderSeats(st, compact);
    renderTrumpSpot(st);
    renderCenter(st);
    renderTrick(st, compact);
  }

  const myBid = bidRaw(st, me);
  const canBid = st.phase === "bidding" && myBid === undefined &&
    ((st.bidding_mode !== "sequential" && st.bidding_mode !== "canadian") || st.current_player === me);
  $("bid-panel").classList.toggle("hidden", !canBid);
  if (canBid) {
    S.bidVal = Math.min(S.bidVal, st.current_round);
    $("bid-value").textContent = S.bidVal;
    $("bid-info").textContent = `Your bid (0–${st.current_round})`;
    $("btn-bid").textContent = `Bid ${S.bidVal}`;
  }

  const choosing = st.phase === "waiting_trump" && st.current_player === me;
  $("trump-panel").classList.toggle("hidden", !choosing);

  const roundOver = st.phase === "round_over";
  $("roundover-panel").classList.toggle("hidden", !roundOver);
  if (roundOver) {
    const ready = st.ready || [];
    const iam = ready.includes(me);
    $("ready-info").textContent = `${ready.length} of ${n} ready`;
    $("btn-ready").disabled = iam;
    $("btn-ready").textContent = iam ? "Waiting…" : `Ready for round ${st.current_round}`;
  }

  const myTurn = st.phase === "playing" && st.current_player === me && !st.trick_complete;
  if (!myTurn) S.selected = null;
  if (S.selected != null && !st.legal_moves.includes(S.selected)) S.selected = null;
  const hand = $("hand");
  const showHand = !isLobby && !over && st.hand.length > 0;
  $("hand-panel").classList.toggle("hidden", !showHand);
  hand.classList.toggle("my-turn", myTurn);
  hand.innerHTML = st.hand.map((c, i) => {
    const legal = myTurn && st.legal_moves.includes(i);
    const cls = [!myTurn ? "" : (legal ? "legal" : "illegal"), S.selected === i ? "selected" : ""].join(" ");
    return cardHTML(c, { cls, attrs: `data-card="${i}" title="${cardName(c)}"` });
  }).join("");
  layoutFan(hand);
  hand.querySelectorAll("[data-card]").forEach((el) => {
    el.onclick = () => {
      const i = parseInt(el.dataset.card, 10);
      if (!(myTurn && st.legal_moves.includes(i))) return;
      S.selected = S.selected === i ? null : i;
      renderGame();
    };
  });
  const playBtn = $("btn-play");
  playBtn.classList.toggle("hidden", !(myTurn && S.selected != null));
  playBtn.textContent = S.selected != null ? `Play ${cardName(st.hand[S.selected])}` : "Play card";

  $("gameover-panel").classList.toggle("hidden", !over);
  if (over) renderGameOver(st);

  renderScores(st);
  refreshTeamScores();
}

/* ----- actions ----- */
async function doAction(body) {
  try {
    await gapi(`/${S.session.game_id}/action`, "POST",
      { player_id: S.session.player_id, ...body });
  } catch (e) { alertMsg(e.message); }
}
function playCard(i) { doAction({ action: "play", value: i }); }
$("btn-play").onclick = () => {
  if (S.selected == null) return;
  const i = S.selected;
  S.selected = null;
  playCard(i);
};

function setBid(v) {
  const max = S.state ? S.state.current_round : 0;
  S.bidVal = Math.max(0, Math.min(max, v));
  $("bid-value").textContent = S.bidVal;
  $("btn-bid").textContent = `Bid ${S.bidVal}`;
}
$("bid-minus").onclick = () => setBid(S.bidVal - 1);
$("bid-plus").onclick = () => setBid(S.bidVal + 1);
$("btn-bid").onclick = () => doAction({ action: "bid", value: S.bidVal }).then(() => { S.bidVal = 0; });

document.querySelectorAll(".suit-picker .suit").forEach((b) =>
  b.onclick = () => doAction({ action: "choose_trump", value: 0, suit: b.dataset.suit }));

$("btn-start").onclick = async () => {
  try { await gapi(`/${S.session.game_id}/start`, "POST"); }
  catch (e) { alertMsg(e.message); }
};
$("btn-ready").onclick = async () => {
  try {
    await gapi(`/${S.session.game_id}/ready`, "POST",
      { player_id: S.session.player_id, action: "ready", value: 0 });
  } catch (e) { alertMsg(e.message); }
};

/* ----- lobby + teams ----- */
function renderLobby(st) {
  $("lobby-players").innerHTML = st.players.map((_, i) => playerBadge(st, i)).join("");
  renderTeamEditor(st);
}

function renderTeamEditor(st) {
  const ed = $("team-editor");
  const assigned = new Set(S.draftTeams.flatMap((t) => t.player_indices));
  const unassigned = st.players.map((_, i) => i).filter((i) => !assigned.has(i));

  ed.innerHTML = S.draftTeams.map((t, ti) => `
    <div class="team-block">
      <div class="thead">
        <span class="tname"><span class="team-dot" style="background:${esc(t.color)}"></span>${esc(t.name)}
          ${t.league_team_id ? `<span class="hint">league team</span>` : ""}</span>
        <button data-del-team="${ti}" class="ghost">✕</button>
      </div>
      <div>${t.player_indices.map((pi) =>
        `<span class="chip">${esc(st.players[pi])}<button data-unassign="${ti}:${pi}">✕</button></span>`).join("")
        || `<span class="hint">No players yet</span>`}</div>
      ${unassigned.length ? `
        <div class="row">
          <select id="assign-${ti}">
            <option value="">Add player…</option>
            ${unassigned.map((pi) => `<option value="${pi}">${esc(st.players[pi])}</option>`).join("")}
          </select>
          <button data-doassign="${ti}" class="ghost">Add</button>
        </div>` : ""}
    </div>`).join("") || `<div class="empty">No teams yet — add one below or load from a league.</div>`;

  ed.querySelectorAll("[data-del-team]").forEach((b) =>
    b.onclick = () => { S.draftTeams.splice(+b.dataset.delTeam, 1); renderTeamEditor(S.state); });
  ed.querySelectorAll("[data-unassign]").forEach((b) =>
    b.onclick = () => {
      const [ti, pi] = b.dataset.unassign.split(":").map(Number);
      S.draftTeams[ti].player_indices = S.draftTeams[ti].player_indices.filter((x) => x !== pi);
      renderTeamEditor(S.state);
    });
  ed.querySelectorAll("[data-doassign]").forEach((b) =>
    b.onclick = () => {
      const ti = +b.dataset.doassign;
      const sel = $(`assign-${ti}`);
      if (sel.value !== "") {
        S.draftTeams[ti].player_indices.push(+sel.value);
        renderTeamEditor(S.state);
      }
    });
}

$("btn-add-team").onclick = () => {
  const name = $("new-team-name").value.trim();
  if (!name) return alertMsg("Give the team a name.");
  S.draftTeams.push({
    name, color: $("new-team-color").value,
    player_indices: [], league_team_id: null,
  });
  $("new-team-name").value = "";
  renderTeamEditor(S.state);
};

$("btn-save-teams").onclick = async () => {
  if (!S.draftTeams.length) return alertMsg("Add at least one team first.");
  try {
    await lapi(`/games/${S.session.game_id}/teams`, "POST", {
      league_id: S.draftLeagueId,
      teams: S.draftTeams.map((t) => ({
        id: t.league_team_id || undefined,
        name: t.name, color: t.color, player_indices: t.player_indices,
      })),
    });
    alertMsg("Teams saved.", true);
    refreshTeamScores();
  } catch (e) { alertMsg(e.message); }
};

$("btn-league-load").onclick = async () => {
  const lid = $("league-load").value;
  if (!lid) return;
  try {
    const league = await lapi(`/leagues/${lid}`);
    S.draftLeagueId = lid;
    S.draftTeams = Object.values(league.teams).map((t) => ({
      name: t.name, color: t.color, player_indices: [], league_team_id: t.id,
    }));
    renderTeamEditor(S.state);
  } catch (e) { alertMsg(e.message); }
};

async function loadGameTeams() {
  try {
    const teams = await lapi(`/games/${S.session.game_id}/teams`);
    if (teams.length && !S.draftTeams.length) {
      S.draftLeagueId = teams[0].league_id;
      S.draftTeams = teams.map((t) => ({ ...t, league_team_id: t.league_team_id }));
    }
  } catch { /* no teams yet */ }
}

/* ----- scores ----- */
function renderScores(st) {
  const me = st.player_id;
  const order = st.players.map((_, i) => i).sort((a, b) => st.scores[b] - st.scores[a]);
  $("scores").innerHTML = order.map((i, rank) => `
    <div class="score-row ${i === me ? "me" : ""}">
      <div class="who"><span class="hint">${rank + 1}</span>${avatarHTML(st.players[i])}
        <span>${esc(st.players[i])}</span>${isLeader(st, i) ? " 👑" : ""}</div>
      <div><span class="meta">${seatStat(st, i).replace(/<[^>]+>/g, "") || ""}</span>
        <span class="score-total">${st.scores[i]}</span></div>
    </div>`).join("");

  const hist = st.history || [];
  const head = `<tr><th>Rd</th>${st.players.map((p) => `<th title="${esc(p)}">${esc(p.slice(0, 6))}</th>`).join("")}</tr>`;
  const rows = hist.map((h) => `<tr><td class="rnd">${h.round}</td>${st.players.map((_, i) => {
    const d = h.deltas[i];
    return `<td><span class="d ${d >= 0 ? "pos" : "neg"}">${d > 0 ? "+" : ""}${d}</span><span class="bw">${h.tricks[i]}/${h.bids[String(i)]}</span></td>`;
  }).join("")}</tr>`).join("");
  const live = ["bidding", "playing"].includes(st.phase)
    ? `<tr><td class="rnd">${st.current_round}</td>${st.players.map((_, i) => {
        const raw = bidRaw(st, i);
        const bid = typeof raw === "number" ? raw : (raw === null ? "?" : "–");
        return `<td><span class="bw">${st.trick_wins[i] ?? 0}/${bid}</span></td>`;
      }).join("")}</tr>`
    : "";
  const total = `<tr><td class="rnd">Σ</td>${st.players.map((_, i) => `<td><strong>${st.scores[i]}</strong></td>`).join("")}</tr>`;
  $("score-history").innerHTML = hist.length || live
    ? `<table class="history"><thead>${head}</thead><tbody>${rows}${live}${total}</tbody></table>`
    : "";
}

function openScores(open) {
  $("score-drawer").classList.toggle("hidden", !open);
  $("drawer-scrim").classList.toggle("hidden", !open);
}
$("btn-scores").onclick = () => openScores($("score-drawer").classList.contains("hidden"));
$("btn-scores-close").onclick = () => openScores(false);
$("drawer-scrim").onclick = () => openScores(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openScores(false); });
$("g-room").onclick = async () => {
  if (!S.session) return;
  try {
    await navigator.clipboard.writeText(S.session.game_id);
    alertMsg("Room code copied.", true);
  } catch { alertMsg(`Room code: ${S.session.game_id}`, true); }
};

let resizeRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (S.state) renderGame(); });
});

let teamScoreTimer = null;
async function refreshTeamScores() {
  if (!S.session) return;
  clearTimeout(teamScoreTimer);
  try {
    const scores = await lapi(`/games/${S.session.game_id}/team-scores`);
    $("teams-card").classList.toggle("hidden", !scores.length);
    $("team-scores").innerHTML = scores.map((t) => `
      <div class="score-row team-row" style="border-color:${esc(t.color)}">
        <div><span class="team-dot" style="background:${esc(t.color)}"></span><strong>${esc(t.name)}</strong>
          <div class="meta">${t.player_names.map(esc).join(", ")}</div></div>
        <div><strong>${t.score}</strong></div>
      </div>`).join("");
  } catch { /* teams endpoint may 404 before any assignment */ }
  teamScoreTimer = setTimeout(refreshTeamScores, 8000);
}

function renderGameOver(st) {
  const order = st.players.map((_, i) => i).sort((a, b) => st.scores[b] - st.scores[a]);
  $("final-scores").innerHTML = order.map((i, r) =>
    `<div class="score-row"><div>${r === 0 ? "🏆 " : ""}<strong>${esc(st.players[i])}</strong></div>
     <div><strong>${st.scores[i]}</strong></div></div>`).join("");
  const hasTeams = S.draftTeams.length > 0;
  $("record-league").classList.toggle("hidden", !hasTeams);
  if (hasTeams) refreshLeagueSelects();
}

async function refreshLeagueSelects() {
  try {
    const leagues = await lapi("/leagues");
    const opts = leagues.map((l) =>
      `<option value="${esc(l.id)}" ${l.id === S.draftLeagueId ? "selected" : ""}>${esc(l.name)}</option>`).join("");
    $("league-load").innerHTML = `<option value="">Load teams from league…</option>` + opts;
    $("record-league-select").innerHTML = `<option value="">Record to league…</option>` + opts;
  } catch { /* leagues unavailable */ }
}

$("btn-record").onclick = async () => {
  const lid = $("record-league-select").value;
  if (!lid) return alertMsg("Pick a league first.");
  try {
    const rec = await lapi(`/leagues/${lid}/record`, "POST", { game_id: S.session.game_id });
    alertMsg(rec.winner_team_id ? "Result recorded!" : "Result recorded (tie — no winner).", true);
  } catch (e) { alertMsg(e.message); }
};

/* ---------- leagues view ---------- */
async function loadLeaguesHome() {
  $("league-screen").classList.add("hidden");
  $("leagues-home").classList.remove("hidden");
  try {
    const leagues = await lapi("/leagues");
    $("leagues-list").innerHTML = leagues.length ? leagues.map((l) => `
      <div class="session-row">
        <div><strong>${esc(l.name)}</strong>
          <span class="hint">${Object.keys(l.teams).length} teams · ${Object.keys(l.players).length} players · ${l.games.length} games</span></div>
        <div class="row" style="margin:0">
          <button data-open-league="${esc(l.id)}">Open</button>
          <button data-del-league="${esc(l.id)}" class="ghost">✕</button>
        </div>
      </div>`).join("")
      : `<div class="empty">No leagues yet — create one.</div>`;
    $("leagues-list").querySelectorAll("[data-open-league]").forEach((b) =>
      b.onclick = () => openLeague(b.dataset.openLeague));
    $("leagues-list").querySelectorAll("[data-del-league]").forEach((b) =>
      b.onclick = async () => {
        if (!confirm("Delete this league?")) return;
        await lapi(`/leagues/${b.dataset.delLeague}`, "DELETE");
        loadLeaguesHome();
      });
  } catch (e) { $("leagues-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

$("btn-create-league").onclick = async () => {
  const name = $("league-name").value.trim();
  if (!name) return;
  try {
    const l = await lapi("/leagues", "POST", { name });
    $("league-name").value = "";
    openLeague(l.id);
  } catch (e) { alert(e.message); }
};

$("btn-league-back").onclick = () => loadLeaguesHome();

async function openLeague(id) {
  const league = await lapi(`/leagues/${id}`);
  S.league = league;
  $("leagues-home").classList.add("hidden");
  $("league-screen").classList.remove("hidden");
  $("league-title").textContent = league.name;
  setLeagueTab("teams");
  renderLeagueTeams();
}

function setLeagueTab(which) {
  ["teams", "standings", "games"].forEach((t) => {
    $(`tab-${t}`).classList.toggle("active", t === which);
    $(`league-tab-${t}`).classList.toggle("hidden", t !== which);
  });
  if (which === "standings") renderStandings();
  if (which === "games") renderLeagueGames();
}
$("tab-teams").onclick = () => setLeagueTab("teams");
$("tab-standings").onclick = () => setLeagueTab("standings");
$("tab-games").onclick = () => setLeagueTab("games");

function renderLeagueTeams() {
  const L = S.league;
  const players = Object.values(L.players);
  $("league-players").innerHTML = players.length ? players.map((p) =>
    `<span class="chip">${esc(p.name)}<button data-del-p="${esc(p.id)}">✕</button></span>`).join("")
    : `<div class="empty">No players yet.</div>`;
  $("league-players").querySelectorAll("[data-del-p]").forEach((b) =>
    b.onclick = async () => {
      await lapi(`/leagues/${L.id}/players/${b.dataset.delP}`, "DELETE");
      await refreshLeague();
    });

  const teams = Object.values(L.teams);
  $("league-teams").innerHTML = teams.length ? teams.map((t) => {
    const roster = t.player_ids.map((pid) => L.players[pid]).filter(Boolean);
    const available = players.filter((p) => !t.player_ids.includes(p.id));
    return `<div class="team-block">
      <div class="thead">
        <span class="tname"><span class="team-dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</span>
        <button data-del-t="${esc(t.id)}" class="ghost">✕</button>
      </div>
      <div>${roster.map((p) =>
        `<span class="chip">${esc(p.name)}<button data-rm="${esc(t.id)}:${esc(p.id)}">✕</button></span>`).join("")
        || `<span class="hint">Empty roster</span>`}</div>
      ${available.length ? `<div class="row">
        <select id="add-${esc(t.id)}">
          <option value="">Add player…</option>
          ${available.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
        </select>
        <button data-add="${esc(t.id)}" class="ghost">Add</button>
      </div>` : ""}
    </div>`;
  }).join("") : `<div class="empty">No teams yet.</div>`;

  $("league-teams").querySelectorAll("[data-del-t]").forEach((b) =>
    b.onclick = async () => {
      if (!confirm("Delete this team?")) return;
      await lapi(`/leagues/${L.id}/teams/${b.dataset.delT}`, "DELETE");
      await refreshLeague();
    });
  $("league-teams").querySelectorAll("[data-rm]").forEach((b) =>
    b.onclick = async () => {
      const [tid, pid] = b.dataset.rm.split(":");
      await lapi(`/leagues/${L.id}/teams/${tid}/roster/${pid}`, "DELETE");
      await refreshLeague();
    });
  $("league-teams").querySelectorAll("[data-add]").forEach((b) =>
    b.onclick = async () => {
      const sel = $(`add-${b.dataset.add}`);
      if (!sel.value) return;
      await lapi(`/leagues/${L.id}/teams/${b.dataset.add}/roster`, "POST", { player_id: sel.value });
      await refreshLeague();
    });
}

$("btn-add-league-player").onclick = async () => {
  const name = $("league-player-name").value.trim();
  if (!name || !S.league) return;
  await lapi(`/leagues/${S.league.id}/players`, "POST", { name });
  $("league-player-name").value = "";
  await refreshLeague();
};

$("btn-add-league-team").onclick = async () => {
  const name = $("league-team-name").value.trim();
  if (!name || !S.league) return;
  await lapi(`/leagues/${S.league.id}/teams`, "POST",
    { name, color: $("league-team-color").value });
  $("league-team-name").value = "";
  await refreshLeague();
};

async function refreshLeague() {
  S.league = await lapi(`/leagues/${S.league.id}`);
  $("league-title").textContent = S.league.name;
  renderLeagueTeams();
}

async function renderStandings() {
  const el = $("standings-table");
  try {
    const rows = await lapi(`/leagues/${S.league.id}/standings`);
    el.innerHTML = rows.length ? `
      <table class="standings">
        <tr><th>Team</th><th>Played</th><th>Wins</th><th>Total pts</th><th>Avg</th></tr>
        ${rows.map((r, i) => `<tr>
          <td>${i === 0 ? "🏆 " : ""}<span class="team-dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</td>
          <td>${r.games_played}</td><td>${r.wins}</td>
          <td><strong>${r.total_points}</strong></td><td>${r.avg_points}</td>
        </tr>`).join("")}
      </table>`
      : `<div class="empty">No games recorded yet.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function renderLeagueGames() {
  const el = $("league-games");
  try {
    const games = await lapi(`/leagues/${S.league.id}/games`);
    el.innerHTML = games.length ? games.map((g) => {
      const scores = Object.entries(g.team_scores)
        .map(([tid, pts]) => `${esc(g.team_names[tid] || tid)}: ${pts}`)
        .join(" · ");
      return `<div class="session-row">
        <div><code>${esc(g.game_id)}</code>
          <span class="hint">${scores}</span></div>
        <span class="hint">${new Date(g.played_at).toLocaleDateString()}</span>
      </div>`;
    }).join("") : `<div class="empty">No games recorded yet.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------- init ---------- */
renderSessions();
const params = new URLSearchParams(location.search);
if (["light", "dark", "system"].includes(params.get("theme") || "")) {
  applyTheme(params.get("theme"));
}
if (params.get("rejoin") && params.get("token")) {
  resumeSession({
    game_id: params.get("rejoin"),
    token: params.get("token"),
    player_id: 0,
    name: params.get("name") || "",
  });
} else {
  try {
    const active = JSON.parse(sessionStorage.getItem("wizard_active") || "null");
    if (active && active.token) resumeSession(active);
  } catch { /* ignore */ }
}
