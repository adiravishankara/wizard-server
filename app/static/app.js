"use strict";
/* Wizard web client: lobby, live game, teams, leagues. */

const API = "/api/game";
const LAPI = "/api/league";

const S = {
  session: null,      // {game_id, player_id, token, name}
  state: null,        // PlayerState from server
  ws: null,
  wsRetry: null,
  draftTeams: [],     // custom lobby teams when no league is linked: [{name, color, player_indices}]
  leagues: [],
  link: null,         // league link for the current game (seats -> league players)
  teamScores: [],
  bidVal: 0,
  selected: null,     // hand index pending confirm
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
  const inGame = !$("game-screen").classList.contains("hidden") && !$("view-games").classList.contains("hidden");
  const el = inGame ? $("game-alert") : $("toast");
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

const NAME_KEY = "wizard_player_name";
function rememberedName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}
function rememberName(name) {
  const n = String(name || "").trim();
  if (!n) return;
  try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ }
}
function joinUrl(code) {
  return `${location.origin}/join/${encodeURIComponent(code)}`;
}
function parseJoinCode() {
  const path = (location.pathname || "").replace(/\/+$/, "") || "/";
  const m = path.match(/^\/join\/([^/]+)$/i);
  if (m) return decodeURIComponent(m[1]).trim();
  const room = new URLSearchParams(location.search).get("room");
  return room ? room.trim() : "";
}
function clearJoinPath() {
  const params = new URLSearchParams(location.search);
  params.delete("room");
  const rest = params.toString();
  const next = "/" + (rest ? `?${rest}` : "") + location.hash;
  if (location.pathname !== "/" || location.search.includes("room=")) {
    history.replaceState(null, "", next);
  }
}
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    alertMsg(okMsg || "Copied", true);
    return true;
  } catch {
    alertMsg("Could not copy");
    return false;
  }
}

/* ---------- navigation ---------- */
function showView(which, opts = {}) {
  $("view-games").classList.toggle("hidden", which !== "games");
  $("view-leagues").classList.toggle("hidden", which !== "leagues");
  $("nav-games").classList.toggle("active", which === "games");
  $("nav-leagues").classList.toggle("active", which === "leagues");
  if (which === "leagues") {
    if (opts.leagueId) openLeague(opts.leagueId, opts.tab);
    else loadLeaguesHome();
  }
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
function fillRememberedNames() {
  const n = rememberedName();
  if (!n) return;
  if (!$("new-name").value) $("new-name").value = n;
  if (!$("join-name").value) $("join-name").value = n;
  if (!$("jl-name").value) $("jl-name").value = n;
}

$("btn-create").onclick = async () => {
  const name = $("new-name").value.trim();
  if (!name) return alertMsg("Enter your name first.");
  try {
    const r = await gapi("/join", "POST", {
      name, bidding_mode: $("new-bidding").value,
    });
    rememberName(name);
    enterGame({ game_id: r.game_id, player_id: r.player_id, token: r.token, name });
  } catch (e) { alertMsg(e.message); }
};

$("btn-join").onclick = async () => {
  const code = $("join-code").value.trim();
  const name = $("join-name").value.trim();
  if (!code || !name) return alertMsg("Enter a game code and your name.");
  try {
    const r = await gapi("/join", "POST", { name, game_id: code });
    rememberName(name);
    enterGame({ game_id: r.game_id, player_id: r.player_id, token: r.token, name });
  } catch (e) { alertMsg(e.message); }
};

function showGamesHome() {
  $("join-link-panel").classList.add("hidden");
  $("games-home").classList.remove("hidden");
  $("jl-error").classList.add("hidden");
  $("jl-form").classList.remove("hidden");
  fillRememberedNames();
  renderSessions();
}

function showJoinLinkError(msg) {
  $("jl-form").classList.add("hidden");
  $("jl-error").classList.remove("hidden");
  $("jl-error-msg").textContent = msg;
  $("jl-meta").textContent = "";
}

async function openJoinFromLink(code) {
  showView("games");
  $("game-screen").classList.add("hidden");
  $("games-home").classList.add("hidden");
  $("join-link-panel").classList.remove("hidden");
  $("jl-code").textContent = code;
  $("jl-meta").textContent = "Checking room…";
  $("jl-error").classList.add("hidden");
  $("jl-form").classList.remove("hidden");
  fillRememberedNames();
  $("jl-name").focus();

  const existing = getSessions().find((s) => s.game_id === code && s.token);
  if (existing) {
    if (await resumeSession(existing)) {
      clearJoinPath();
      return;
    }
  }

  try {
    const info = await gapi(`/${encodeURIComponent(code)}/join-info`);
    if (!info.open) {
      showJoinLinkError(info.detail || "This room is not open for new players.");
      return;
    }
    $("jl-meta").textContent = `${info.players} player${info.players === 1 ? "" : "s"} in lobby`;
  } catch (e) {
    const msg = String(e.message || "");
    if (/not found/i.test(msg)) {
      showJoinLinkError("This room was not found or has expired.");
    } else {
      showJoinLinkError(msg || "Could not open this room.");
    }
  }
}

$("btn-jl-join").onclick = async () => {
  const code = ($("jl-code").textContent || "").trim();
  const name = $("jl-name").value.trim();
  if (!code) return showJoinLinkError("Missing room code.");
  if (!name) return alertMsg("Enter your name first.");
  try {
    const r = await gapi("/join", "POST", { name, game_id: code });
    rememberName(name);
    clearJoinPath();
    enterGame({ game_id: r.game_id, player_id: r.player_id, token: r.token, name });
  } catch (e) {
    const msg = String(e.message || "");
    if (/not found/i.test(msg)) {
      showJoinLinkError("This room was not found or has expired.");
    } else if (/full|already started/i.test(msg)) {
      showJoinLinkError("This game is full or has already started.");
    } else {
      alertMsg(msg);
    }
  }
};

$("btn-jl-home").onclick = () => {
  clearJoinPath();
  showGamesHome();
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
    if (r.player_id !== sess.player_id) removeSession(sess);
    enterGame({
      game_id: r.game_id,
      player_id: r.player_id,
      token: sess.token,
      name: r.name,
    });
    return true;
  } catch (e) {
    alertMsg(e.message);
    const msg = String(e.message || "");
    if (/not found|invalid session/i.test(msg)) {
      removeSession(sess);
      renderSessions();
    }
    return false;
  }
}

/* ---------- game screen ---------- */
function enterGame(sess) {
  S.session = sess;
  S.selected = null;
  saveSession(sess);
  S.draftTeams = [];
  S.link = null;
  S.teamScores = [];
  S.lastPhase = null;
  $("join-link-panel").classList.add("hidden");
  $("games-home").classList.add("hidden");
  $("game-screen").classList.remove("hidden");
  $("g-code").textContent = sess.game_id;
  connectWS();
  loadLeaguesList().then(loadGameLink);
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
  document.body.classList.remove("bidding", "sheet-open-trump", "sheet-open-bid");
  $("game-screen").classList.add("hidden");
  clearJoinPath();
  showGamesHome();
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
      followSeat(S.state.player_id);
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

/* Seats can move in the lobby (shuffle); keep the stored session pointing at ours. */
function followSeat(seat) {
  const sess = S.session;
  if (!sess || typeof seat !== "number" || seat === sess.player_id) return;
  removeSession(sess);
  S.session = { ...sess, player_id: seat };
  saveSession(S.session);
}

/* ----- cards ----- */
const SUIT_SYM = { H: "♥", D: "♦", C: "♣", S: "♠" };
const SUIT_NAME = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const MAX_ROUNDS = { 3: 20, 4: 15, 5: 12, 6: 10 };
const isRedSuit = (s) => s === "H" || s === "D";
const suitClass = (s) => ({ H: "suit-h", D: "suit-d", C: "suit-c", S: "suit-s" }[s] || "");
const SUIT_DESC = { H: "Crimson suit", D: "Royal blue suit", C: "Forest green suit", S: "Obsidian suit" };
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
  return `<div class="pcard ${suitClass(card.suit) || (isRedSuit(card.suit) ? "red" : "black")} ${cls}"${style} ${attrs}>
    <div class="idx tl">${idx}</div>${face}<div class="idx br">${idx}</div></div>`;
}
function suitTileCard(suit, cls = "") {
  return `<div class="pcard suit-tile-card ${suitClass(suit)} ${cls}"><div class="ace">${SUIT_SYM[suit]}</div></div>`;
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
  const maxW = (container.clientWidth || 360) - 16;
  // Keep a readable hand when there are many cards (late rounds).
  const base = Math.min(96, Math.max(52, Math.floor(maxW / Math.max(4.2, n * 0.55))));
  cards.forEach((el) => { el.style.setProperty("--cw", `${base}px`); });
  const w = base;
  const step = n === 1 ? 0 : Math.min(w * 0.62, (maxW - w) / (n - 1));
  const mid = (n - 1) / 2;
  const flat = container.classList.contains("view-only");
  const spread = flat ? Math.min(1.6, 14 / n) : Math.min(3.2, 26 / n);
  const lift = flat ? 0.15 : 0.4;
  cards.forEach((el, i) => {
    const d = i - mid;
    el.style.marginLeft = i === 0 ? "0px" : `${(step - w).toFixed(1)}px`;
    el.style.zIndex = String(i + 1);
    el.style.setProperty("--fr", `${(d * spread).toFixed(2)}deg`);
    el.style.setProperty("--fy", `${(d * d * spread * lift).toFixed(1)}px`);
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
function avatarHTML(name, hue) {
  return `<div class="avatar" style="--hue:${hue ?? avatarHue(name)}">${esc(initials(name))}</div>`;
}
function lobbySeat(st, i, moved) {
  const name = st.players[i];
  const me = st.player_id === i;
  return `<div class="lseat ${me ? "me" : ""} ${moved ? "moved" : ""}" style="--d:${i * 70}ms">
    <span class="lseat-no">${i + 1}</span>
    ${avatarHTML(name)}
    <span class="lseat-name">${esc(name)}${me ? ` <span class="you-tag">you</span>` : ""}</span>
    ${st.host === i ? `<span class="host-badge">${CROWN_ICON}Host</span>` : ""}
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
    return `<div class="trump-tile ${suitClass(st.trump_suit)}" title="Trump: ${SUIT_NAME[st.trump_suit]}">${SUIT_SYM[st.trump_suit]}</div>`;
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
    label = `Trump <span class="${suitClass(st.trump_suit)}">${SUIT_SYM[st.trump_suit]}</span>`;
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
    trumpEl.removeAttribute("data-suit");
  } else if (st.trump_suit) {
    trumpEl.innerHTML = `Trump <span class="${suitClass(st.trump_suit)}">${SUIT_SYM[st.trump_suit]}</span>`;
    trumpEl.classList.remove("none");
    trumpEl.dataset.suit = st.trump_suit;
  } else {
    trumpEl.textContent = "No trump";
    trumpEl.classList.add("none");
    trumpEl.removeAttribute("data-suit");
  }
  const isLobby = st.phase === "lobby";
  const over = st.phase === "game_over";
  if (over && S.lastPhase && S.lastPhase !== "game_over") loadLeaguesList().then(loadGameLink);
  S.lastPhase = st.phase;
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

  if (!isLobby && !over) {
    renderOppRail(st, compact);
    renderLeadChip(st);
    renderTurnBanner(st);
  } else {
    $("opp-rail").classList.add("hidden");
    $("lead-chip").classList.add("hidden");
    $("turn-banner").classList.add("hidden");
    $("play-slot").classList.add("hidden");
  }

  const myBid = bidRaw(st, me);
  const canBid = st.phase === "bidding" && myBid === undefined &&
    ((st.bidding_mode !== "sequential" && st.bidding_mode !== "canadian") || st.current_player === me);
  $("bid-panel").classList.toggle("hidden", !canBid);
  document.body.classList.toggle("bidding", canBid);
  if (canBid) renderBidBar(st);

  const choosing = st.phase === "waiting_trump" && st.current_player === me;
  setSheet("trump", choosing);
  if (choosing) renderTrumpSheet(st);

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
  hand.classList.toggle("view-only", st.phase === "bidding");
  const slot = $("play-slot");
  slot.classList.toggle("hidden", !myTurn);
  slot.classList.toggle("active", myTurn && S.selected != null);
  hand.innerHTML = st.hand.map((c, i) => {
    const legal = myTurn && st.legal_moves.includes(i);
    const cls = [
      !myTurn ? "" : (legal ? "legal" : "illegal"),
      S.selected === i ? "lifted selected" : "",
    ].join(" ");
    return cardHTML(c, { cls, attrs: `data-card="${i}" title="${cardName(c)}"` });
  }).join("");
  layoutFan(hand);
  bindHandGestures(hand, myTurn);
  const playBtn = $("btn-play");
  playBtn.classList.toggle("hidden", !(myTurn && S.selected != null) || isCompact());
  playBtn.textContent = S.selected != null ? `Play ${cardName(st.hand[S.selected])}` : "Play card";
  const you = $("you-chip");
  const showYou = showHand && !isLobby && st.phase !== "bidding"
    && !(st.phase === "playing" && st.current_player === me && !st.trick_complete);
  you.classList.toggle("hidden", !showYou);
  if (showYou) {
    const raw = bidRaw(st, me);
    const won = st.trick_wins[me] ?? 0;
    you.textContent = `You ${typeof raw === "number" ? `${won}/${raw}` : won}`;
  }

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
  $("btn-bid").textContent = `Lock ${S.bidVal}`;
  $("bid-nums")?.querySelectorAll(".bid-num").forEach((b) => {
    b.classList.toggle("selected", +b.dataset.bid === S.bidVal);
  });
  const sel = $("bid-nums")?.querySelector(".bid-num.selected");
  if (sel) try { sel.scrollIntoView({ inline: "center", block: "nearest" }); } catch { /* ignore */ }
}
$("btn-bid").onclick = () => doAction({ action: "bid", value: S.bidVal }).then(() => { S.bidVal = 0; });

$("btn-shuffle").onclick = async () => {
  const btn = $("btn-shuffle");
  btn.disabled = true;
  try { await gapi(`/${S.session.game_id}/shuffle`, "POST", { token: S.session.token }); }
  catch (e) { alertMsg(e.message); }
  btn.disabled = false;
};
$("shuffle-on-start").onchange = async (e) => {
  try {
    await gapi(`/${S.session.game_id}/lobby-settings`, "POST",
      { token: S.session.token, shuffle_on_start: e.target.checked });
  } catch (err) {
    alertMsg(err.message);
    e.target.checked = !e.target.checked;
  }
};
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

/* ----- lobby: league link + custom teams ----- */
function setSheet(kind, open) {
  $(`${kind}-panel`).classList.toggle("hidden", !open);
  $(`${kind}-scrim`)?.classList.toggle("hidden", !open);
  document.body.classList.toggle(`sheet-open-${kind}`, open);
}

function renderBidBar(st) {
  const max = st.current_round;
  S.bidVal = Math.min(S.bidVal, max);
  const placed = Object.values(st.bids || {}).filter((b) => typeof b === "number");
  const total = placed.reduce((a, b) => a + b, 0);
  const open = st.bidding_mode !== "secret";
  $("bid-info").textContent = `0–${max}`;
  $("bid-total").innerHTML = `<span class="bt-label">Bids</span>
    <span class="bt-val ${total > max ? "over" : ""}">${open ? total : "?"}<span class="bt-den">/${max}</span></span>`;
  $("bid-others").innerHTML = st.players.map((name, i) => {
    if (i === st.player_id) return "";
    const raw = bidRaw(st, i);
    const pending = raw === undefined;
    const shown = pending ? "…" : (raw === null || !open ? "✓" : raw);
    return `<span class="bid-other ${pending ? "pending" : ""}"><span class="bo-name">${esc(name)}</span><b class="bo-bid">${shown}</b></span>`;
  }).join("");
  $("bid-nums").innerHTML = Array.from({ length: max + 1 }, (_, v) =>
    `<button type="button" class="bid-num ${v === S.bidVal ? "selected" : ""}" data-bid="${v}">${v}</button>`).join("");
  $("bid-nums").querySelectorAll(".bid-num").forEach((b) => {
    b.onclick = () => setBid(+b.dataset.bid);
  });
  $("btn-bid").textContent = `Lock ${S.bidVal}`;
  const sel = $("bid-nums").querySelector(".bid-num.selected");
  if (sel) try { sel.scrollIntoView({ inline: "center", block: "nearest" }); } catch { /* ignore */ }
}

function renderTrumpSheet(st) {
  const flip = (st.flip && st.flip.card) || { type: "wizard" };
  $("trump-hero").innerHTML = `${cardHTML(flip, { cls: "flip-big" })}
    <p class="trump-hero-kicker">Round ${st.current_round} · Wizard flipped</p>
    <h2 class="trump-hero-title">Choose trump suit</h2>`;
  $("trump-actions").innerHTML = ["H", "D", "C", "S"].map((suit) => `
    <button type="button" class="suit-row ${suitClass(suit)}" data-suit="${suit}">
      <span class="sr-icon">${SUIT_SYM[suit]}</span>
      <span><span class="sr-name">${SUIT_NAME[suit]}</span><span class="sr-desc">${SUIT_DESC[suit]}</span></span>
      <span class="sr-go" aria-hidden="true">›</span>
    </button>`).join("");
  $("trump-actions").querySelectorAll("[data-suit]").forEach((b) => {
    b.onclick = () => doAction({ action: "choose_trump", value: 0, suit: b.dataset.suit });
  });
}

function renderOppRail(st, compact) {
  const rail = $("opp-rail");
  if (!compact) { rail.classList.add("hidden"); rail.innerHTML = ""; return; }
  rail.classList.remove("hidden");
  const n = st.players.length;
  rail.innerHTML = st.players.map((name, i) => {
    if (i === st.player_id) return "";
    const raw = bidRaw(st, i);
    let stat = "–";
    let cls = "";
    if (st.phase === "bidding") {
      if (raw === undefined) stat = "…";
      else if (raw === null) stat = "✓";
      else stat = String(raw);
    } else if (st.phase !== "waiting_trump" && st.phase !== "lobby") {
      const won = st.trick_wins[i] ?? 0;
      const bid = typeof raw === "number" ? raw : "?";
      stat = `${won}/${bid}`;
      if (typeof raw === "number") cls = won === raw ? "made" : (won > raw ? "over" : "");
    }
    const classes = ["opp-pill", isTurn(st, i) ? "turn" : "", trickWinner(st) === i ? "won" : ""];
    return `<div class="${classes.join(" ")}" data-seat="${i}">
      <div class="avatar-wrap">${isLeader(st, i) ? CROWN_SVG : ""}${avatarHTML(name)}${
        i === st.dealer_idx ? `<span class="dealer-chip" title="Dealer">D</span>` : ""}</div>
      <span class="opp-name">${esc(name)}</span>
      <span class="opp-stat ${cls}">${stat}</span>
    </div>`;
  }).join("");
}

function renderLeadChip(st) {
  const el = $("lead-chip");
  const trick = st.current_trick || [];
  if (st.phase !== "playing" || !trick.length) { el.classList.add("hidden"); return; }
  const lead = trick[0][1];
  if (lead.type !== "regular" || !lead.suit) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `Lead: <span class="${suitClass(lead.suit)}">${SUIT_SYM[lead.suit]} ${SUIT_NAME[lead.suit]}</span>`;
}

function renderTurnBanner(st) {
  const el = $("turn-banner");
  const me = st.player_id;
  const myTurn = st.phase === "playing" && st.current_player === me && !st.trick_complete;
  if (!myTurn) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const trick = st.current_trick || [];
  const lead = trick[0] && trick[0][1];
  let msg = "Your turn";
  if (lead && lead.type === "regular" && lead.suit) {
    msg = `Your turn — follow ${SUIT_SYM[lead.suit]}`;
  } else if (!trick.length) {
    msg = "Your lead";
  }
  const raw = bidRaw(st, me);
  const won = st.trick_wins[me] ?? 0;
  el.classList.remove("hidden");
  el.innerHTML = `<span class="tb-main">${esc(msg)}</span>
    <span class="tb-you">You ${typeof raw === "number" ? `${won}/${raw}` : won}</span>`;
}

function bindHandGestures(hand, myTurn) {
  if (S._handCtl) S._handCtl.abort();
  S._handCtl = new AbortController();
  const signal = S._handCtl.signal;
  hand.querySelectorAll("[data-card]").forEach((el) => {
    const i = parseInt(el.dataset.card, 10);
    el.addEventListener("click", () => {
      if (S._dragPlayed) { S._dragPlayed = false; return; }
      if (!(myTurn && S.state.legal_moves.includes(i))) return;
      if (S.selected === i) { S.selected = null; playCard(i); return; }
      S.selected = i;
      renderGame();
    }, { signal });
    if (!(myTurn && S.state.legal_moves.includes(i))) return;
    let startY = 0, startX = 0, dragging = false, ghost = null;
    const onDown = (ev) => {
      const pt = ev.touches ? ev.touches[0] : ev;
      startY = pt.clientY; startX = pt.clientX; dragging = false;
      S._dragCard = i;
    };
    const onMove = (ev) => {
      if (S._dragCard !== i) return;
      const pt = ev.touches ? ev.touches[0] : ev;
      const dy = startY - pt.clientY;
      const dx = Math.abs(pt.clientX - startX);
      if (!dragging && dy > 18 && dy > dx) {
        dragging = true;
        S.selected = i;
        el.classList.add("dragging");
        ghost = el.cloneNode(true);
        ghost.classList.add("ghost-drag");
        ghost.classList.remove("dragging", "lifted");
        ghost.style.width = `${el.offsetWidth}px`;
        ghost.style.height = `${el.offsetHeight}px`;
        document.body.appendChild(ghost);
        $("play-slot").classList.add("drag-over");
      }
      if (dragging && ghost) {
        if (ev.cancelable) ev.preventDefault();
        ghost.style.left = `${pt.clientX}px`;
        ghost.style.top = `${pt.clientY}px`;
        const slot = $("play-slot").getBoundingClientRect();
        const over = pt.clientX >= slot.left - 20 && pt.clientX <= slot.right + 20
          && pt.clientY >= slot.top - 40 && pt.clientY <= slot.bottom + 20;
        $("play-slot").classList.toggle("drag-over", over);
      }
    };
    const onUp = (ev) => {
      if (S._dragCard !== i) return;
      S._dragCard = null;
      const pt = ev.changedTouches ? ev.changedTouches[0] : ev;
      const dy = startY - (pt ? pt.clientY : startY);
      let played = false;
      if (dragging && pt) {
        const slot = $("play-slot").getBoundingClientRect();
        const over = pt.clientX >= slot.left - 20 && pt.clientX <= slot.right + 20
          && pt.clientY >= slot.top - 40 && pt.clientY <= slot.bottom + 20;
        if (over || dy > 90) {
          S.selected = null; playCard(i); played = true; S._dragPlayed = true;
        }
      } else if (!dragging && dy > 100) {
        S.selected = null; playCard(i); played = true; S._dragPlayed = true;
      }
      if (ghost) ghost.remove();
      el.classList.remove("dragging");
      $("play-slot").classList.remove("drag-over");
      if (!played && dragging) renderGame();
    };
    el.addEventListener("pointerdown", onDown, { signal });
    window.addEventListener("pointermove", onMove, { signal });
    window.addEventListener("pointerup", onUp, { signal });
    el.addEventListener("touchstart", onDown, { signal, passive: true });
    window.addEventListener("touchmove", onMove, { signal, passive: false });
    window.addEventListener("touchend", onUp, { signal });
  });
}

function lobbyMoves(st) {
  const gid = S.session.game_id;
  const prev = S.lobbyOrder;
  S.lobbyOrder = { gid, names: st.players.slice() };
  const now = Date.now();
  if (prev && prev.gid === gid && prev.names.length === st.players.length
      && prev.names.some((n, i) => n !== st.players[i])
      && [...prev.names].sort().join("\n") === [...st.players].sort().join("\n")) {
    S.lobbyMoved = { gid, until: now + 1600, names: new Set(st.players.filter((n, i) => prev.names[i] !== n)) };
    const seatOf = Object.fromEntries(st.players.map((n, i) => [n, i]));
    S.draftTeams.forEach((t) => {
      t.player_indices = t.player_indices.map((i) => seatOf[prev.names[i]]).filter((i) => i !== undefined);
    });
  }
  const m = S.lobbyMoved;
  return m && m.gid === gid && m.until > now ? m.names : new Set();
}

function renderLobby(st) {
  const moved = lobbyMoves(st);
  const isHost = st.host === st.player_id || st.host == null;
  const code = S.session.game_id;
  const url = joinUrl(code);
  $("lobby-code").textContent = code;
  const link = $("lobby-join-link");
  link.textContent = url;
  link.href = url;
  link.onclick = (e) => {
    e.preventDefault();
    copyText(url, "Join link copied");
  };
  $("lobby-players").innerHTML = st.players.map((n, i) => lobbySeat(st, i, moved.has(n))).join("");
  const tags = [];
  if (st.rematch_of) tags.push(`<span class="pill">Rematch</span>`);
  if (st.seats_shuffled) tags.push(`<span class="pill pill-accent">Seats shuffled</span>`);
  if (st.shuffle_on_start && !isHost) tags.push(`<span class="pill">Shuffle at start</span>`);
  $("lobby-tags").innerHTML = tags.join("");
  const modes = [
    ["sequential", "Sequential", "Normal turn order"],
    ["simultaneous", "Simultaneous", "Everyone bids at once"],
    ["secret", "Blind", "Bids hidden until the hand ends"],
    ["canadian", "Canadian", "Last bidder can't even the total"],
  ];
  $("lobby-mode").innerHTML = modes.map(([k, title, sub]) => `
    <button type="button" class="mode-tile ${st.bidding_mode === k ? "selected" : ""}" data-mode="${k}" ${isHost ? "" : "disabled"}>
      <strong>${title}</strong><span>${sub}</span>
    </button>`).join("");
  $("lobby-mode").querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = async () => {
      if (!isHost || b.dataset.mode === st.bidding_mode) return;
      try {
        await gapi(`/${S.session.game_id}/lobby-settings`, "POST",
          { token: S.session.token, bidding_mode: b.dataset.mode });
      } catch (e) { alertMsg(e.message); }
    };
  });
  const waiting = st.waiting_for || [];
  $("lobby-waiting").classList.toggle("hidden", !waiting.length);
  $("lobby-waiting").innerHTML = `<span class="hint">Waiting for</span>${waiting.map((n) =>
    `<span class="wait-chip">${avatarHTML(n)}<span>${esc(n)}</span></span>`).join("")}`;
  $("lobby-tools").classList.toggle("hidden", !isHost);
  $("btn-shuffle").disabled = st.players.length < 2;
  $("shuffle-on-start").checked = !!st.shuffle_on_start;
  const startBtn = $("btn-start");
  startBtn.classList.toggle("primary", isHost);
  startBtn.classList.toggle("ghost", !isHost);
  renderLeagueLink(st);
  const linked = !!(S.link && S.link.league_id);
  $("custom-teams").classList.toggle("hidden", linked);
  if (!linked) renderTeamEditor(st);
}

const leagueById = (id) => (id ? S.leagues.find((l) => l.id === id) : null);
const byName = (a, b) => a.name.localeCompare(b.name);

function renderLeagueLink(st) {
  const sel = $("link-league");
  const cur = (S.link && S.link.league_id) || "";
  sel.innerHTML = `<option value="">No league</option>` + S.leagues.map((l) =>
    `<option value="${esc(l.id)}" ${l.id === cur ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  sel.value = leagueById(cur) ? cur : "";
  const league = leagueById(cur);
  if (league && (S.link.seats.length !== st.players.length
      || S.link.seats.some((x, i) => x.name !== st.players[i]))) loadGameLink();
  if (!league) {
    $("link-seats").innerHTML = "";
    $("link-teams").innerHTML = "";
    return;
  }
  const players = Object.values(league.players).sort(byName);
  const teamOf = {};
  Object.values(league.teams).forEach((t) => t.player_ids.forEach((pid) => { teamOf[pid] = t; }));
  $("link-seats").innerHTML = S.link.seats.map((s) => {
    const t = s.league_player_id && teamOf[s.league_player_id];
    return `<div class="link-row" style="--tc:${esc(t ? t.color : "transparent")}">
      ${avatarHTML(s.name)}
      <span class="link-name">${esc(s.name)}</span>
      <select data-link-seat="${s.seat}" aria-label="League player for ${esc(s.name)}">
        <option value="">Guest</option>
        ${players.map((p) => `<option value="${esc(p.id)}" ${p.id === s.league_player_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
      </select>
    </div>`;
  }).join("");
  $("link-seats").querySelectorAll("[data-link-seat]").forEach((el) => {
    el.onchange = () => {
      const seats = {};
      $("link-seats").querySelectorAll("[data-link-seat]").forEach((x) => { seats[x.dataset.linkSeat] = x.value || null; });
      saveLink(league.id, seats);
    };
  });
  $("link-teams").innerHTML = S.link.teams.map((t) => `
    <div class="link-team" style="--tc:${esc(t.color)}">
      <span class="tchip"><i></i>${esc(t.name)}</span>
      <span class="hint">${t.player_indices.map((i) => esc(st.players[i])).join(", ")}</span>
    </div>`).join("");
}

async function loadLeaguesList() {
  try { S.leagues = await lapi("/leagues"); } catch { S.leagues = []; }
}

async function loadGameLink() {
  if (!S.session || loadGameLink.busy) return;
  loadGameLink.busy = true;
  const gid = S.session.game_id;
  try {
    const [link, teams] = await Promise.all([
      lapi(`/games/${gid}/link`).catch(() => null),
      lapi(`/games/${gid}/teams`).catch(() => []),
    ]);
    if (!S.session || S.session.game_id !== gid) return;
    S.link = link;
    if (!(link && link.league_id) && teams.length && !S.draftTeams.length) {
      S.draftTeams = teams.map((t) => ({ ...t }));
    }
  } finally {
    loadGameLink.busy = false;
  }
  if (S.state) renderGame();
}

async function saveLink(leagueId, seats) {
  try {
    S.link = await lapi(`/games/${S.session.game_id}/link`, "PUT", { league_id: leagueId || null, seats: seats || {} });
  } catch (e) { alertMsg(e.message); }
  if (S.state) renderGame();
}

$("link-league").onchange = async () => {
  const lid = $("link-league").value;
  if (!lid) return saveLink(null, {});
  try {
    await loadLeaguesList();
    const sug = await lapi(`/games/${S.session.game_id}/link/suggest?league_id=${encodeURIComponent(lid)}`);
    const seats = {};
    sug.seats.forEach((s) => { seats[s.seat] = s.league_player_id; });
    await saveLink(lid, seats);
  } catch (e) { alertMsg(e.message); }
};

function renderTeamEditor(st) {
  const ed = $("team-editor");
  const assigned = new Set(S.draftTeams.flatMap((t) => t.player_indices));
  const unassigned = st.players.map((_, i) => i).filter((i) => !assigned.has(i));

  ed.innerHTML = S.draftTeams.map((t, ti) => `
    <div class="team-block">
      <div class="thead">
        <span class="tname"><span class="team-dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</span>
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
    </div>`).join("");

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
  S.draftTeams.push({ name, color: $("new-team-color").value, player_indices: [] });
  $("new-team-name").value = "";
  renderTeamEditor(S.state);
};

$("btn-save-teams").onclick = async () => {
  if (!S.draftTeams.length) return alertMsg("Add at least one team first.");
  try {
    await lapi(`/games/${S.session.game_id}/teams`, "POST", {
      teams: S.draftTeams.map((t) => ({ name: t.name, color: t.color, player_indices: t.player_indices })),
    });
    alertMsg("Teams saved.", true);
    refreshTeamScores();
  } catch (e) { alertMsg(e.message); }
};

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
async function shareOrCopyJoinLink() {
  if (!S.session) return;
  const code = S.session.game_id;
  const url = joinUrl(code);
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: "Join my Wizard game",
        text: `Join room ${code}`,
        url,
      });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  await copyText(url, "Join link copied");
}
$("btn-copy-link").onclick = async () => {
  if (!S.session) return;
  await copyText(joinUrl(S.session.game_id), "Join link copied");
};
$("btn-share-link").onclick = () => shareOrCopyJoinLink();
$("g-room").onclick = async () => {
  if (!S.session) return;
  await copyText(joinUrl(S.session.game_id), "Join link copied");
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
    S.teamScores = scores;
    $("teams-card").classList.toggle("hidden", !scores.length);
    $("team-scores").innerHTML = scores.map((t) => `
      <div class="score-row team-row" style="border-color:${esc(t.color)}">
        <div><span class="team-dot" style="background:${esc(t.color)}"></span><strong>${esc(t.name)}</strong>
          <div class="meta">${t.player_names.map(esc).join(", ")}</div></div>
        <div><strong>${t.score}</strong></div>
      </div>`).join("");
    if (S.state && S.state.phase === "game_over") renderGameOver(S.state);
  } catch { /* game may be gone */ }
  teamScoreTimer = setTimeout(refreshTeamScores, 8000);
}

/* ----- points journey ----- */
const journeys = new Map();
function mountJourney(root, series, key, opts = {}) {
  const prev = journeys.get(root);
  if (prev && prev.key === key) return;
  const ctl = PointsChart.mount(root, series, opts);
  journeys.set(root, { key, series, opts, width: root.clientWidth, ctl });
}
function dropJourney(root) {
  journeys.delete(root);
  root.innerHTML = "";
}
let journeyResize = null;
window.addEventListener("resize", () => {
  clearTimeout(journeyResize);
  journeyResize = setTimeout(() => {
    journeys.forEach((j, root) => {
      if (!root.isConnected) { journeys.delete(root); return; }
      if (!root.offsetParent) return;
      if (Math.abs(root.clientWidth - j.width) < 24) return;
      j.ctl = PointsChart.mount(root, j.series, { ...j.opts, animate: false });
      j.width = root.clientWidth;
    });
  }, 150);
});

function seatHues(names) {
  return PointsChart.distinctHues(names.map(avatarHue));
}
function historySeries(st, hues) {
  const hist = st.history || [];
  return st.players.map((name, i) => ({
    name,
    hue: hues[i],
    points: hist.map((h) => (h.deltas || [])[i] ?? 0),
    totals: hist.map((h) => (h.scores || [])[i] ?? 0),
  }));
}

/* ----- game over ----- */
function renderGameOver(st) {
  const order = st.players.map((_, i) => i).sort((a, b) => st.scores[b] - st.scores[a]);
  const top = st.scores[order[0]];
  const winners = order.filter((i) => st.scores[i] === top);
  $("go-title").textContent = winners.length > 1
    ? `Tie · ${winners.map((i) => st.players[i]).join(" & ")}`
    : `${st.players[winners[0]]} wins`;
  const rounds = (st.history || []).length;
  $("go-sub").textContent = [plural(rounds, "round"), MODE_LABEL[st.bidding_mode]].filter(Boolean).join(" · ");

  const hues = seatHues(st.players);
  const chart = $("go-chart");
  chart.classList.toggle("hidden", !rounds);
  if (rounds) mountJourney(chart, historySeries(st, hues), `${S.session.game_id}:${rounds}`);
  renderRematch(st);

  const ts = S.teamScores || [];
  const teamOfSeat = {};
  ts.forEach((t) => t.player_indices.forEach((i) => { teamOfSeat[i] = t; }));
  $("final-scores").innerHTML = order.map((i) => {
    const t = teamOfSeat[i];
    const rank = order.findIndex((j) => st.scores[j] === st.scores[i]) + 1;
    return `<div class="go-row ${winners.includes(i) ? "top" : ""} ${i === st.player_id ? "me" : ""}">
      <span class="rank r${rank}">${rank}</span>
      ${avatarHTML(st.players[i], hues[i])}
      <span class="go-name">${esc(st.players[i])}${t ? teamChip(t.name, t.color) : ""}</span>
      <span class="go-score">${st.scores[i]}</span>
    </div>`;
  }).join("");

  const goTeams = $("go-teams");
  goTeams.classList.toggle("hidden", !ts.length);
  if (ts.length) {
    const best = Math.max(...ts.map((t) => t.score));
    const nBest = ts.filter((t) => t.score === best).length;
    goTeams.innerHTML = [...ts].sort((a, b) => b.score - a.score).map((t) => {
      const win = t.score === best;
      const badge = win ? (nBest > 1 ? `<span class="tie-badge">Tie</span>` : `<span class="win-badge">Winner</span>`) : "";
      return `<div class="go-team ${win ? "win" : ""}" style="--tc:${esc(t.color)}">
        <div class="go-team-top"><span class="tchip"><i></i>${esc(t.name)}</span>${badge}</div>
        <div class="go-team-score">${t.score}</div>
        <div class="hint">${t.player_names.map(esc).join(", ")}</div>
      </div>`;
    }).join("");
  }
  renderRecordBox();
}

function renderRematch(st) {
  const box = $("go-rematch");
  const rm = st.rematch;
  if (!rm) {
    box.innerHTML = `<label class="rm-shuffle"><input type="checkbox" id="rm-shuffle" ${S.rmShuffle === false ? "" : "checked"}>
        <span>Shuffle seats</span></label>
      <button class="primary" type="button" id="btn-rematch">Rematch</button>`;
    $("rm-shuffle").onchange = (e) => { S.rmShuffle = e.target.checked; };
    $("btn-rematch").onclick = () => goRematch(true);
    return;
  }
  const joined = rm.joined || [];
  const inIt = joined.includes(st.player_id);
  const stack = joined.length
    ? `<span class="av-stack" title="${esc(joined.map((i) => st.players[i]).join(", "))}">${joined.map((i) => avatarHTML(st.players[i])).join("")}</span>
       <span class="rm-count">${joined.length}/${st.players.length}</span>`
    : "";
  if (rm.started && !inIt) {
    box.innerHTML = `${stack}<span class="pill">Rematch started</span>`;
    return;
  }
  box.innerHTML = `${stack}<button class="primary" type="button" id="btn-rematch-join">${inIt ? "Back to rematch" : "Join rematch"}</button>`;
  $("btn-rematch-join").onclick = () => goRematch(false);
}

async function goRematch(create) {
  const sess = S.session;
  if (!sess) return;
  const btn = $(create ? "btn-rematch" : "btn-rematch-join");
  if (btn) btn.disabled = true;
  try {
    const r = create
      ? await gapi(`/${sess.game_id}/rematch`, "POST", { token: sess.token, shuffle: S.rmShuffle !== false })
      : await gapi(`/${sess.game_id}/rematch/join`, "POST", { token: sess.token });
    openScores(false);
    enterGame({ game_id: r.game_id, player_id: r.player_id, token: r.token, name: r.name });
  } catch (e) {
    alertMsg(e.message);
    if (btn) btn.disabled = false;
  }
}

function renderRecordBox() {
  const link = S.link || {};
  const recorded = !!link.recorded_record_id;
  const linked = leagueById(link.league_id);
  $("record-league").classList.toggle("hidden", !S.leagues.length && !recorded);
  const sel = $("record-league-select");
  sel.classList.toggle("hidden", !!linked || recorded);
  if (!linked) {
    const v = sel.value;
    sel.innerHTML = `<option value="">Choose league…</option>` + S.leagues.map((l) =>
      `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
    sel.value = leagueById(v) ? v : "";
  }
  const btn = $("btn-record");
  btn.disabled = recorded;
  btn.textContent = recorded ? `Recorded${linked ? ` to ${linked.name}` : ""} ✓`
    : linked ? `Record to ${linked.name}` : "Record result";
  $("btn-view-standings").classList.toggle("hidden", !recorded);
}

$("btn-record").onclick = async () => {
  const lid = (S.link && S.link.league_id) || $("record-league-select").value;
  if (!lid) return alertMsg("Pick a league first.");
  const btn = $("btn-record");
  btn.disabled = true;
  try {
    const rec = await lapi(`/leagues/${lid}/record`, "POST", { game_id: S.session.game_id });
    S.link = { ...(S.link || { seats: [], teams: [] }), league_id: lid, recorded_record_id: rec.id };
    alertMsg("Result recorded.", true);
  } catch (e) {
    alertMsg(e.message);
  }
  await loadLeaguesList();
  await loadGameLink();
  renderRecordBox();
};

$("btn-view-standings").onclick = () => {
  const lid = S.link && S.link.league_id;
  if (lid) showView("leagues", { leagueId: lid, tab: S.teamScores.length ? "teams" : "players" });
};

/* ---------- shared UI ---------- */
const MODE_LABEL = { sequential: "Sequential", simultaneous: "Simultaneous", secret: "Blind", canadian: "Canadian" };
const TEAM_COLORS = ["#7c4dff", "#e7a51b", "#2f9e6a", "#e0475b", "#2b8fd6", "#e8742c", "#c043b8", "#5a6b7d"];
const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || `${word}s`)}`;
const fmtNum = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
function fmtDate(iso, opts) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" });
}
const isoDay = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const teamChip = (name, color) => `<span class="tchip" style="--tc:${esc(color)}"><i></i>${esc(name)}</span>`;
const CROWN_ICON = `<svg class="crown-ic" viewBox="0 0 24 16" aria-hidden="true"><path d="M2 14 L4 4 L9 9 L12 2 L15 9 L20 4 L22 14 Z" fill="#f5c542" stroke="#8a6a12" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
function avatarStack(names, max = 5) {
  const shown = names.slice(0, max).map((n) => avatarHTML(n)).join("");
  const more = names.length > max ? `<span class="avatar more">+${names.length - max}</span>` : "";
  return `<span class="av-stack">${shown}${more}</span>`;
}
const emptyState = (title, action = "") => `<div class="lg-empty"><div class="lg-empty-title">${esc(title)}</div>${action}</div>`;

function openModal(html, cls = "") {
  const m = $("modal");
  m.className = `modal ${cls}`;
  m.innerHTML = html;
  $("modal-scrim").classList.remove("hidden");
  m.querySelectorAll("[data-close]").forEach((b) => { b.onclick = closeModal; });
  return m;
}
function closeModal() {
  $("modal").classList.add("hidden");
  $("modal-scrim").classList.add("hidden");
  $("modal").innerHTML = "";
}
$("modal-scrim").onclick = closeModal;

function confirmDialog({ title, body = "", confirmLabel = "Delete", danger = true }) {
  return new Promise((resolve) => {
    const el = $("confirm");
    el.innerHTML = `
      <h2>${esc(title)}</h2>
      ${body ? `<p class="confirm-body">${esc(body)}</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="ghost" data-answer="no">Cancel</button>
        <button type="button" class="${danger ? "danger" : "primary"}" data-answer="yes">${esc(confirmLabel)}</button>
      </div>`;
    el.classList.remove("hidden");
    $("confirm-scrim").classList.remove("hidden");
    const done = (v) => {
      el.classList.add("hidden");
      $("confirm-scrim").classList.add("hidden");
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
    };
    document.addEventListener("keydown", onKey, true);
    $("confirm-scrim").onclick = () => done(false);
    el.querySelector('[data-answer="no"]').onclick = () => done(false);
    el.querySelector('[data-answer="yes"]').onclick = () => done(true);
    el.querySelector('[data-answer="yes"]').focus();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("modal").classList.contains("hidden") && $("confirm").classList.contains("hidden")) closeModal();
});

/* ---------- leagues view ---------- */
const LG = { league: null, board: [], standings: [], tab: "players", newTeamColor: null };

async function loadLeaguesHome() {
  $("league-screen").classList.add("hidden");
  $("leagues-home").classList.remove("hidden");
  const list = $("leagues-list");
  try {
    const leagues = await lapi("/leagues");
    S.leagues = leagues;
    $("leagues-summary").textContent = leagues.length ? plural(leagues.length, "league") : "";
    if (!leagues.length) {
      list.innerHTML = emptyState("No leagues yet");
      return;
    }
    const boards = await Promise.all(leagues.map((l) => lapi(`/leagues/${l.id}/leaderboard`).catch(() => [])));
    list.innerHTML = leagues.map((l, i) => leagueCardHTML(l, boards[i])).join("");
    list.querySelectorAll("[data-open-league]").forEach((card) => {
      card.onclick = () => openLeague(card.dataset.openLeague, "players");
      card.onkeydown = (e) => { if (e.key === "Enter") openLeague(card.dataset.openLeague, "players"); };
    });
    list.querySelectorAll("[data-del-league]").forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const l = leagues.find((x) => x.id === b.dataset.delLeague);
        const ok = await confirmDialog({
          title: `Delete ${l.name}?`,
          body: `Its ${plural(Object.keys(l.players).length, "player")}, ${plural(Object.keys(l.teams).length, "team")} and ${plural(l.games.length, "recorded game")} will be removed.`,
          confirmLabel: "Delete league",
        });
        if (!ok) return;
        try { await lapi(`/leagues/${l.id}`, "DELETE"); } catch (err) { alertMsg(err.message); }
        loadLeaguesHome();
      };
    });
  } catch (e) {
    list.innerHTML = emptyState(e.message);
  }
}

function leagueCardHTML(l, board) {
  const players = Object.values(l.players);
  const teams = Object.values(l.teams);
  const leader = board.find((r) => r.games_played > 0);
  const last = l.games.length ? l.games.reduce((a, g) => (g.played_at > a ? g.played_at : a), "") : null;
  return `<article class="lg-card" data-open-league="${esc(l.id)}" tabindex="0" role="button" aria-label="Open ${esc(l.name)}">
    <div class="lg-card-bar">${teams.map((t) => `<span style="background:${esc(t.color)}"></span>`).join("")}</div>
    <div class="lg-card-top">
      <h2>${esc(l.name)}</h2>
      <button type="button" class="ghost icon-btn lg-del" data-del-league="${esc(l.id)}" aria-label="Delete ${esc(l.name)}">✕</button>
    </div>
    <div class="lg-card-people">${players.length ? avatarStack(players.map((p) => p.name)) : ""}<span class="hint">${plural(players.length, "player")}</span></div>
    <div class="lg-card-chips">
      <span class="pill">${plural(teams.length, "team")}</span>
      <span class="pill">${plural(l.games.length, "game")}</span>
      ${last ? `<span class="pill">${fmtDate(last, { month: "short", day: "numeric" })}</span>` : ""}
    </div>
    <div class="lg-card-leader">${leader
      ? `${CROWN_ICON}<strong>${esc(leader.name)}</strong><span class="hint">${plural(leader.wins, "win")}</span>`
      : `<span class="hint">No games yet</span>`}</div>
  </article>`;
}

$("league-create").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("league-name").value.trim();
  if (!name) return;
  try {
    const l = await lapi("/leagues", "POST", { name });
    $("league-name").value = "";
    openLeague(l.id, "roster");
  } catch (err) { alertMsg(err.message); }
};

$("btn-league-back").onclick = () => loadLeaguesHome();
$("btn-add-result").onclick = () => openResultForm(null);

async function openLeague(id, tab) {
  LG.tab = tab || "players";
  $("leagues-home").classList.add("hidden");
  $("league-screen").classList.remove("hidden");
  try {
    await refreshLeague(id);
  } catch (e) {
    alertMsg(e.message);
    loadLeaguesHome();
  }
}

async function refreshLeague(id = LG.league && LG.league.id) {
  const [league, board, standings] = await Promise.all([
    lapi(`/leagues/${id}`), lapi(`/leagues/${id}/leaderboard`), lapi(`/leagues/${id}/standings`),
  ]);
  Object.assign(LG, { league, board, standings });
  const L = league;
  $("league-title").textContent = L.name;
  $("league-meta").textContent = [
    plural(Object.keys(L.players).length, "player"),
    plural(Object.keys(L.teams).length, "team"),
    plural(L.games.length, "game"),
  ].join(" · ");
  setLeagueTab(LG.tab);
}

const LEAGUE_TABS = ["players", "teams", "games", "roster"];
function setLeagueTab(which) {
  LG.tab = which;
  LEAGUE_TABS.forEach((t) => {
    $(`tab-${t}`).classList.toggle("active", t === which);
    $(`tab-${t}`).setAttribute("aria-selected", t === which ? "true" : "false");
    $(`league-tab-${t}`).classList.toggle("hidden", t !== which);
  });
  ({ players: renderPlayersTab, teams: renderTeamsTab, games: renderGamesTab, roster: renderRosterTab })[which]();
}
LEAGUE_TABS.forEach((t) => { $(`tab-${t}`).onclick = () => setLeagueTab(t); });

function wireGoto(root) {
  root.querySelectorAll("[data-goto]").forEach((b) => { b.onclick = () => setLeagueTab(b.dataset.goto); });
  root.querySelectorAll("[data-add-result]").forEach((b) => { b.onclick = () => openResultForm(null); });
}

const rankBadge = (rank) => `<span class="rank r${rank}">${rank}</span>`;
function bidMeter(acc) {
  if (acc == null) return `<span class="muted-dash">—</span>`;
  const pct = Math.round(acc * 100);
  return `<span class="meter"><span class="meter-fill" style="width:${pct}%"></span></span><span class="meter-val">${pct}%</span>`;
}

function renderPlayersTab() {
  const pane = $("league-tab-players");
  const rows = LG.board;
  if (!rows.length) {
    pane.innerHTML = emptyState("No players yet", `<button class="primary" data-goto="roster">Add players</button>`);
    return wireGoto(pane);
  }
  let rank = 0;
  let prevKey = null;
  pane.innerHTML = `<div class="lb lb-players">
    <div class="lb-row lb-headrow"><span>#</span><span>Player</span><span>Games</span><span>Wins</span><span>Avg</span><span>Best</span><span>Bid accuracy</span></div>
    ${rows.map((r, i) => {
      const key = `${r.wins}|${r.ties}|${r.avg_score}`;
      if (key !== prevKey) { rank = i + 1; prevKey = key; }
      const played = r.games_played > 0;
      return `<div class="lb-row ${played ? "" : "idle"}">
        ${played ? rankBadge(rank) : `<span class="rank">–</span>`}
        <span class="lb-who">${avatarHTML(r.name)}<span class="lb-name"><strong>${esc(r.name)}</strong>${r.team_name ? teamChip(r.team_name, r.team_color) : `<span class="tchip none">No team</span>`}</span></span>
        <span class="lb-stat" data-label="Games">${r.games_played}</span>
        <span class="lb-stat" data-label="Wins">${r.wins}${r.ties ? `<small>+${plural(r.ties, "tie")}</small>` : ""}</span>
        <span class="lb-stat" data-label="Avg">${played ? fmtNum(r.avg_score) : "—"}</span>
        <span class="lb-stat" data-label="Best">${r.best_score ?? "—"}</span>
        <span class="lb-stat lb-bids" data-label="Accuracy">${bidMeter(r.bid_accuracy)}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function renderTeamsTab() {
  const pane = $("league-tab-teams");
  const L = LG.league;
  const rows = LG.standings;
  if (!rows.length) {
    pane.innerHTML = emptyState("No teams yet", `<button class="primary" data-goto="roster">Create a team</button>`);
    return wireGoto(pane);
  }
  pane.innerHTML = `<div class="lb lb-teams">
    <div class="lb-row lb-headrow"><span>#</span><span>Team</span><span>Games</span><span>Wins</span><span>Points</span><span>Avg</span></div>
    ${rows.map((r, i) => {
      const names = r.player_ids.map((pid) => L.players[pid]).filter(Boolean).map((p) => p.name);
      const played = r.games_played > 0;
      return `<div class="lb-row team ${played ? "" : "idle"}" style="--tc:${esc(r.color)}">
        ${played ? rankBadge(i + 1) : `<span class="rank">–</span>`}
        <span class="lb-who"><span class="team-swatch"></span><span class="lb-name"><strong>${esc(r.name)}</strong>
          <span class="lb-members">${names.length ? avatarStack(names, 4) : ""}<span class="hint">${plural(names.length, "player")}</span></span></span></span>
        <span class="lb-stat" data-label="Games">${r.games_played}</span>
        <span class="lb-stat" data-label="Wins">${r.wins}${r.ties ? `<small>+${plural(r.ties, "tie")}</small>` : ""}</span>
        <span class="lb-stat" data-label="Points">${r.total_points}</span>
        <span class="lb-stat" data-label="Avg">${played ? fmtNum(r.avg_points) : "—"}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function winnerLine(g) {
  if (!g.winner_names.length) return `<span class="hint">No scores</span>`;
  return g.player_tie
    ? `<span class="tie-badge">Tie</span><span>${g.winner_names.map(esc).join(" & ")}</span>`
    : `${CROWN_ICON}<span>${esc(g.winner_names[0])}</span>`;
}

function gameMeta(g) {
  return [
    MODE_LABEL[g.bidding_mode],
    g.rounds_played ? plural(g.rounds_played, "round") : null,
    plural(g.players.length, "player"),
    g.source === "manual" ? "Added by hand" : null,
  ].filter(Boolean).join(" · ");
}

function teamResultChips(g) {
  const ids = Object.keys(g.team_scores).sort((a, b) => g.team_scores[b] - g.team_scores[a]);
  return ids.map((tid) => {
    const win = g.winner_team_ids.includes(tid);
    return `<span class="tscore ${win ? "win" : ""}" style="--tc:${esc(g.team_colors[tid] || "#888")}"><i></i>${esc(g.team_names[tid] || "Team")}<b>${g.team_scores[tid]}</b></span>`;
  }).join("");
}

function renderGamesTab() {
  const pane = $("league-tab-games");
  const games = [...LG.league.games].sort((a, b) => (a.played_at < b.played_at ? 1 : -1));
  if (!games.length) {
    pane.innerHTML = emptyState("No games recorded yet", `<button class="primary" data-add-result>Add result</button>`);
    return wireGoto(pane);
  }
  pane.innerHTML = `<div class="gm-list">${games.map((g) => {
    const d = new Date(g.played_at);
    return `<button type="button" class="gm-card" data-open-game="${esc(g.id)}">
      <span class="gm-date"><b>${d.getDate()}</b><small>${d.toLocaleDateString(undefined, { month: "short" })}</small></span>
      <span class="gm-main">
        <span class="gm-winner">${winnerLine(g)}</span>
        <span class="gm-meta">${esc(gameMeta(g))}</span>
        <span class="gm-players">${avatarStack(g.players.map((p) => p.name), 6)}</span>
      </span>
      <span class="gm-teams">${teamResultChips(g)}</span>
      <span class="gm-chev" aria-hidden="true">›</span>
    </button>`;
  }).join("")}</div>`;
  pane.querySelectorAll("[data-open-game]").forEach((b) => { b.onclick = () => openGameDetail(b.dataset.openGame); });
}

function trumpCell(r) {
  if (r.trump_source === "jester") return `<span class="rt-nt" title="Jester flipped">J</span>`;
  if (!r.trump) return `<span class="rt-nt" title="No trump">–</span>`;
  const who = r.trump_source === "wizard" ? `Wizard flipped${r.trump_chosen_by ? ` · ${r.trump_chosen_by} chose` : ""}` : SUIT_NAME[r.trump];
  return `<span class="rt-suit ${isRedSuit(r.trump) ? "red" : ""}" title="${esc(who)}">${SUIT_SYM[r.trump]}</span>${r.trump_source === "wizard" ? `<sup class="rt-w">W</sup>` : ""}`;
}

function openGameDetail(rid) {
  const L = LG.league;
  const g = L.games.find((x) => x.id === rid);
  if (!g) return;
  const order = [...g.players].sort((a, b) => b.score - a.score);
  const top = order.length ? order[0].score : null;
  const rankOf = (p) => order.findIndex((q) => q.score === p.score) + 1;
  const bySeat = [...g.players].sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
  const rounds = g.rounds || [];
  const perHand = !g.final_only && rounds.length && bySeat.every((p) => p.seat != null);
  const hues = seatHues(bySeat.map((p) => p.name));
  const lineOf = (r, seat) => (r.players || []).find((l) => l.seat === seat);
  const roundTable = perHand ? `
    <h3>Hand by hand</h3>
    <div class="table-scroll rt-scroll"><table class="rt">
      <thead><tr><th class="rt-hand">#</th><th class="rt-trump">Trump</th>${bySeat.map((p, k) => `
        <th title="${esc(p.name)}"><span class="rt-who">${avatarHTML(p.name, hues[k])}<span>${esc(p.name)}</span></span></th>`).join("")}</tr></thead>
      <tbody>${rounds.map((r) => `<tr>
        <td class="rt-hand">${r.round}${r.cards_dealt && r.cards_dealt !== r.round ? `<small>${r.cards_dealt} cards</small>` : ""}</td>
        <td class="rt-trump">${trumpCell(r)}</td>
        ${bySeat.map((p) => {
          const l = lineOf(r, p.seat) || { points: 0, total: 0 };
          const exact = l.bid != null && l.tricks != null && l.bid === l.tricks;
          return `<td class="rt-cell ${r.dealer_seat === p.seat ? "dealt" : ""}">
            <span class="rt-pts ${l.points >= 0 ? "pos" : "neg"}">${l.points > 0 ? "+" : ""}${l.points}</span>
            <span class="rt-tot">${l.total}</span>
            ${l.bid != null || l.tricks != null ? `<span class="rt-bt ${exact ? "ok" : ""}" title="Won ${l.tricks ?? "–"} · bid ${l.bid ?? "–"}">${l.tricks ?? "–"}/${l.bid ?? "–"}</span>` : ""}
            ${r.dealer_seat === p.seat ? `<span class="rt-dealer" title="Dealer">D</span>` : ""}
          </td>`;
        }).join("")}
      </tr>`).join("")}</tbody>
      <tfoot><tr><td class="rt-hand">Final</td><td></td>${bySeat.map((p) => `
        <td class="rt-cell"><span class="rt-final">${p.score}</span>${rankBadge(rankOf(p))}</td>`).join("")}</tr></tfoot>
    </table></div>` : "";
  const teamIds = Object.keys(g.team_scores).sort((a, b) => g.team_scores[b] - g.team_scores[a]);
  const teams = teamIds.length ? `
    <h3>Teams</h3>
    <div class="gd-teams">${teamIds.map((tid) => {
      const win = g.winner_team_ids.includes(tid);
      const badge = win ? (g.team_tie ? `<span class="tie-badge">Tie</span>` : `<span class="win-badge">Winner</span>`) : "";
      return `<div class="go-team ${win ? "win" : ""}" style="--tc:${esc(g.team_colors[tid] || "#888")}">
        <div class="go-team-top"><span class="tchip"><i></i>${esc(g.team_names[tid] || "Team")}</span>${badge}</div>
        <div class="go-team-score">${g.team_scores[tid]}</div>
        <div class="hint">${g.players.filter((p) => p.team_id === tid).map((p) => esc(p.name)).join(", ")}</div>
      </div>`;
    }).join("")}</div>` : "";

  const m = openModal(`
    <div class="modal-head">
      <div>
        <div class="modal-kicker">${esc(fmtDate(g.played_at, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}</div>
        <h2>${g.player_tie ? "Tie" : esc(g.winner_names[0] || "Game")}${g.player_tie ? "" : " wins"}</h2>
      </div>
      <button type="button" class="ghost icon-btn" data-close aria-label="Close">✕</button>
    </div>
    <div class="gd-chips">
      ${g.bidding_mode ? `<span class="pill">${MODE_LABEL[g.bidding_mode]}</span>` : ""}
      ${g.rounds_played ? `<span class="pill">${plural(g.rounds_played, "round")}</span>` : ""}
      <span class="pill">${g.source === "manual" ? "Added by hand" : "Played here"}</span>
      ${g.final_only ? `<span class="pill pill-muted">Final only</span>` : ""}
      ${g.edited_at ? `<span class="pill">Edited ${esc(fmtDate(g.edited_at, { month: "short", day: "numeric" }))}</span>` : ""}
    </div>
    <div class="gd-players">${order.map((p) => {
      const r = rankOf(p);
      const t = p.team_id && L.teams[p.team_id];
      const tName = g.team_names[p.team_id] || (t && t.name);
      const tColor = g.team_colors[p.team_id] || (t && t.color);
      return `<div class="go-row ${p.score === top ? "top" : ""}">
        ${rankBadge(r)}${avatarHTML(p.name, perHand ? hues[bySeat.indexOf(p)] : undefined)}
        <span class="go-name">${esc(p.name)}${tName ? teamChip(tName, tColor) : ""}${p.league_player_id ? "" : `<span class="tchip none">Guest</span>`}</span>
        ${p.rounds_bid ? `<span class="gd-bids" title="Bids made">${p.bids_made}/${p.rounds_bid}</span>` : ""}
        <span class="go-score">${p.score}</span>
      </div>`;
    }).join("")}</div>
    ${perHand ? `<div class="gd-chart" id="gd-chart"></div>` : ""}
    ${teams}
    ${roundTable}
    ${g.notes ? `<h3>Notes</h3><p class="gd-notes">${esc(g.notes)}</p>` : ""}
    <div class="modal-actions split">
      <button type="button" class="danger-ghost" data-act="delete">Delete</button>
      <button type="button" class="primary" data-act="edit">Edit</button>
    </div>`, "modal-wide");
  const chart = m.querySelector("#gd-chart");
  if (chart) {
    const series = bySeat.map((p, k) => ({
      name: p.name,
      hue: hues[k],
      points: rounds.map((r) => (lineOf(r, p.seat) || {}).points ?? 0),
      totals: rounds.map((r) => (lineOf(r, p.seat) || {}).total ?? 0),
    }));
    requestAnimationFrame(() => mountJourney(chart, series, `${g.id}:${g.edited_at || ""}:${Date.now()}`));
  }
  m.querySelector('[data-act="edit"]').onclick = () => openResultForm(g);
  m.querySelector('[data-act="delete"]').onclick = async () => {
    const ok = await confirmDialog({
      title: "Delete this game?",
      body: `${fmtDate(g.played_at)} · ${g.player_tie ? "Tie" : `${g.winner_names[0]} won`}. Standings and the leaderboard will be recalculated.`,
      confirmLabel: "Delete game",
    });
    if (!ok) return;
    try {
      await lapi(`/leagues/${L.id}/games/${g.id}`, "DELETE");
      closeModal();
      await refreshLeague();
    } catch (e) { alertMsg(e.message); }
  };
}

function openResultForm(rec) {
  const L = LG.league;
  if (!L) return;
  const players = Object.values(L.players).sort(byName);
  let nextKey = 0;
  const recRounds = rec && !rec.final_only ? rec.rounds || [] : [];
  let perHand = recRounds.length > 0;
  let hands = recRounds.length;
  let rmeta = recRounds.map((r) => ({
    cards_dealt: r.cards_dealt, trump: r.trump, dealerKey: r.dealer_seat != null ? `s${r.dealer_seat}` : null,
  }));
  const blank = () => ({ key: `n${nextKey++}`, pid: "", name: "", score: "", bids: "", hand: [], meta: [] });
  let lines = rec
    ? rec.players.map((p, k) => {
        const known = p.league_player_id && L.players[p.league_player_id];
        const own = recRounds.map((r) => (r.players || []).find((l) => l.seat === p.seat) || {});
        return {
          key: p.seat != null ? `s${p.seat}` : `r${k}`,
          pid: known ? p.league_player_id : "", name: known ? "" : p.name,
          score: p.score, bids: p.rounds_bid ? p.bids_made : "",
          hand: own.map((l) => l.points ?? 0),
          meta: own.map((l) => ({ bid: l.bid ?? null, tricks: l.tricks ?? null })),
        };
      })
    : [0, 1, 2, 3].map(blank);

  const m = openModal(`
    <form id="result-form" class="rf" novalidate>
      <div class="modal-head">
        <h2>${rec ? "Edit result" : "Add result"}</h2>
        <button type="button" class="ghost icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="rf-grid">
        <label>Date<input type="date" id="rf-date" value="${isoDay(rec && rec.played_at)}"></label>
        <label>Bidding
          <select id="rf-mode">
            <option value="">—</option>
            ${Object.entries(MODE_LABEL).map(([k, v]) => `<option value="${k}" ${rec && rec.bidding_mode === k ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </label>
        <label>Rounds<input type="number" id="rf-rounds" min="0" max="20" inputmode="numeric" value="${rec ? rec.rounds_played || "" : ""}"></label>
      </div>
      <div class="rf-head"><span>Player</span><span>Score</span><span>Bids made</span><span></span></div>
      <div id="rf-lines" class="rf-lines"></div>
      <div class="rf-row">
        <button type="button" id="rf-add-line" class="ghost rf-add">+ Player</button>
        <label class="check-toggle"><input type="checkbox" id="rf-perhand" ${perHand ? "checked" : ""}><span>Per-hand scores</span></label>
      </div>
      <div id="rf-hands" class="rf-hands hidden"></div>
      <label>Notes<textarea id="rf-notes" rows="2" maxlength="500">${esc(rec ? rec.notes : "")}</textarea></label>
      <div id="rf-error" class="alert hidden"></div>
      <div class="modal-actions">
        <button type="button" class="ghost" data-close>Cancel</button>
        <button type="submit" class="primary">${rec ? "Save changes" : "Add result"}</button>
      </div>
    </form>`, "modal-wide");

  const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? 0 : Math.round(Number(v)));
  const lineName = (ln, i) => (ln.pid && L.players[ln.pid] ? L.players[ln.pid].name : ln.name.trim()) || `Player ${i + 1}`;
  const readLines = () => {
    m.querySelectorAll(".rf-line").forEach((row, i) => {
      const ln = lines[i];
      ln.pid = row.querySelector("[data-f=pid]").value;
      ln.name = row.querySelector("[data-f=name]").value;
      ln.score = row.querySelector("[data-f=score]").value;
      ln.bids = row.querySelector("[data-f=bids]").value;
    });
    m.querySelectorAll("[data-hand]").forEach((inp) => {
      const [r, k] = inp.dataset.hand.split(":").map(Number);
      if (lines[k]) lines[k].hand[r] = inp.value === "" ? "" : num(inp.value);
    });
  };
  const recalc = () => {
    if (!perHand) return;
    lines.forEach((ln, k) => {
      let run = 0;
      for (let r = 0; r < hands; r++) {
        const inp = m.querySelector(`[data-hand="${r}:${k}"]`);
        run += num(inp ? inp.value : ln.hand[r]);
        const cell = m.querySelector(`[data-run="${r}:${k}"]`);
        if (cell) cell.textContent = run;
      }
      const score = m.querySelectorAll(".rf-line [data-f=score]")[k];
      if (score) score.value = run;
      const foot = m.querySelector(`[data-total="${k}"]`);
      if (foot) foot.textContent = run;
    });
  };
  const drawHands = () => {
    const box = m.querySelector("#rf-hands");
    box.classList.toggle("hidden", !perHand);
    m.querySelector("#rf-rounds").disabled = perHand;
    if (perHand) m.querySelector("#rf-rounds").value = hands;
    if (!perHand) { box.innerHTML = ""; return; }
    box.innerHTML = `
      <div class="table-scroll"><table class="rf-hand-table">
        <thead><tr><th>#</th>${lines.map((ln, k) => `<th title="${esc(lineName(ln, k))}">${esc(lineName(ln, k))}</th>`).join("")}</tr></thead>
        <tbody>${Array.from({ length: hands }, (_, r) => `<tr>
          <td class="rf-hn">${r + 1}</td>
          ${lines.map((ln, k) => `<td>
            <input data-hand="${r}:${k}" type="number" inputmode="numeric" step="10" value="${esc(ln.hand[r] ?? "")}" placeholder="0" aria-label="Hand ${r + 1}, ${esc(lineName(ln, k))}">
            <span class="rf-run" data-run="${r}:${k}"></span>
          </td>`).join("")}
        </tr>`).join("")}</tbody>
        <tfoot><tr><td></td>${lines.map((_, k) => `<td data-total="${k}"></td>`).join("")}</tr></tfoot>
      </table></div>
      <div class="rf-hand-btns">
        <button type="button" class="ghost" id="rf-hand-minus" ${hands <= 1 ? "disabled" : ""}>− Hand</button>
        <button type="button" class="ghost" id="rf-hand-plus" ${hands >= 20 ? "disabled" : ""}>+ Hand</button>
      </div>`;
    box.querySelectorAll("[data-hand]").forEach((inp) => { inp.oninput = recalc; });
    box.querySelector("#rf-hand-minus").onclick = () => { readLines(); hands = Math.max(1, hands - 1); drawHands(); };
    box.querySelector("#rf-hand-plus").onclick = () => { readLines(); hands = Math.min(20, hands + 1); drawHands(); };
    recalc();
  };
  const drawLines = () => {
    m.querySelector("#rf-lines").innerHTML = lines.map((ln, i) => `
      <div class="rf-line">
        <div class="rf-who">
          <select data-f="pid" aria-label="Player ${i + 1}">
            <option value="">${ln.name ? "New player" : "Choose player…"}</option>
            ${players.map((p) => `<option value="${esc(p.id)}" ${p.id === ln.pid ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
            <option value="__new" ${!ln.pid && ln.name ? "selected" : ""}>New player…</option>
          </select>
          <input data-f="name" placeholder="Name" maxlength="32" value="${esc(ln.name)}" class="${!ln.pid && ln.name ? "" : "hidden"}" aria-label="New player name">
        </div>
        <input data-f="score" type="number" inputmode="numeric" step="10" value="${esc(ln.score)}" aria-label="Score" placeholder="0" ${perHand ? "readonly tabindex=\"-1\" class=\"rf-auto\"" : ""}>
        <input data-f="bids" type="number" inputmode="numeric" min="0" max="20" value="${esc(ln.bids)}" aria-label="Bids made" placeholder="—">
        <button type="button" class="ghost icon-btn" data-rm-line="${i}" aria-label="Remove player" ${lines.length <= 3 ? "disabled" : ""}>✕</button>
      </div>`).join("");
    m.querySelectorAll("[data-f=pid]").forEach((sel) => {
      sel.onchange = () => {
        const name = sel.parentElement.querySelector("[data-f=name]");
        name.classList.toggle("hidden", sel.value !== "__new");
        if (sel.value === "__new") name.focus();
        else name.value = "";
        if (perHand) { readLines(); drawHands(); }
      };
    });
    m.querySelectorAll("[data-f=name]").forEach((inp) => {
      inp.onchange = () => { if (perHand) { readLines(); drawHands(); } };
    });
    m.querySelectorAll("[data-rm-line]").forEach((b) => {
      b.onclick = () => { readLines(); lines.splice(+b.dataset.rmLine, 1); drawLines(); drawHands(); };
    });
    m.querySelector("#rf-add-line").disabled = lines.length >= 6;
  };
  drawLines();
  drawHands();
  m.querySelector("#rf-add-line").onclick = () => {
    readLines();
    if (lines.length < 6) lines.push(blank());
    drawLines();
    drawHands();
  };
  m.querySelector("#rf-perhand").onchange = (e) => {
    readLines();
    perHand = e.target.checked;
    if (perHand && !hands) {
      const n = lines.filter((ln) => ln.pid || ln.name.trim()).length || lines.length;
      hands = Math.min(20, num(m.querySelector("#rf-rounds").value) || MAX_ROUNDS[n] || 10);
    }
    drawLines();
    drawHands();
  };

  const showErr = (msg) => {
    const el = m.querySelector("#rf-error");
    el.textContent = msg;
    el.classList.remove("hidden");
  };
  m.querySelector("#result-form").onsubmit = async (e) => {
    e.preventDefault();
    readLines();
    const filled = lines.filter((ln) => ln.pid || ln.name.trim() || (!perHand && ln.score !== ""));
    if (filled.length < 3) return showErr("Enter at least 3 players.");
    const out = [];
    for (const ln of filled) {
      const isNew = !ln.pid || ln.pid === "__new";
      if (isNew && !ln.name.trim()) return showErr("Choose a player for every row.");
      if (!perHand && (ln.score === "" || !Number.isFinite(Number(ln.score)))) return showErr("Enter a score for every player.");
      out.push({
        league_player_id: isNew ? null : ln.pid,
        name: isNew ? ln.name.trim() : null,
        score: perHand ? null : Math.round(Number(ln.score)),
        bids_made: ln.bids === "" ? null : Math.round(Number(ln.bids)),
      });
    }
    let rounds = recRounds.length ? [] : null;
    if (perHand) {
      rounds = Array.from({ length: hands }, (_, r) => {
        const meta = rmeta[r] || {};
        const dealer = meta.dealerKey ? filled.findIndex((ln) => ln.key === meta.dealerKey) : -1;
        return {
          cards_dealt: meta.cards_dealt ?? null,
          dealer: dealer >= 0 ? dealer : null,
          trump: meta.trump ?? null,
          lines: filled.map((ln) => ({
            points: num(ln.hand[r]),
            bid: (ln.meta[r] || {}).bid ?? null,
            tricks: (ln.meta[r] || {}).tricks ?? null,
          })),
        };
      });
    }
    const body = {
      played_at: m.querySelector("#rf-date").value || null,
      bidding_mode: m.querySelector("#rf-mode").value || null,
      rounds_played: perHand ? hands : Number(m.querySelector("#rf-rounds").value || 0),
      players: out,
      rounds,
      notes: m.querySelector("#rf-notes").value.trim(),
    };
    try {
      const saved = rec
        ? await lapi(`/leagues/${L.id}/games/${rec.id}`, "PUT", body)
        : await lapi(`/leagues/${L.id}/games`, "POST", body);
      closeModal();
      LG.tab = "games";
      await refreshLeague();
      if (rec) openGameDetail(saved.id);
    } catch (err) { showErr(err.message); }
  };
}

function renderRosterTab() {
  const pane = $("league-tab-roster");
  const L = LG.league;
  const players = Object.values(L.players).sort(byName);
  const teams = Object.values(L.teams).sort(byName);
  const teamOf = {};
  teams.forEach((t) => t.player_ids.forEach((pid) => { teamOf[pid] = t; }));
  const gp = {};
  LG.board.forEach((r) => { gp[r.player_id] = r.games_played; });
  const used = new Set(teams.map((t) => t.color.toLowerCase()));
  if (!LG.newTeamColor || used.has(LG.newTeamColor)) {
    LG.newTeamColor = TEAM_COLORS.find((c) => !used.has(c)) || TEAM_COLORS[0];
  }

  pane.innerHTML = `<div class="ro-grid">
    <section class="card ro-card">
      <div class="ro-head"><h2>Players</h2><span class="count">${players.length}</span></div>
      <form id="form-add-player" class="inline-form">
        <input id="league-player-name" placeholder="Player name" maxlength="32" aria-label="Player name">
        <button type="submit" class="primary">Add</button>
      </form>
      <div class="ro-list">${players.length ? players.map((p) => {
        const t = teamOf[p.id];
        return `<div class="ro-row" style="--tc:${esc(t ? t.color : "transparent")}">
          ${avatarHTML(p.name)}
          <div class="ro-name"><strong>${esc(p.name)}</strong><span class="hint">${plural(gp[p.id] || 0, "game")}</span></div>
          <select class="team-select" data-team-of="${esc(p.id)}" aria-label="Team for ${esc(p.name)}">
            <option value="">No team</option>
            ${teams.map((tm) => `<option value="${esc(tm.id)}" ${t && t.id === tm.id ? "selected" : ""}>${esc(tm.name)}</option>`).join("")}
          </select>
          <button type="button" class="ghost icon-btn" data-del-player="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button>
        </div>`;
      }).join("") : `<div class="ro-none">No players yet</div>`}</div>
    </section>
    <section class="card ro-card">
      <div class="ro-head"><h2>Teams</h2><span class="count">${teams.length}</span></div>
      <form id="form-add-team" class="inline-form">
        <input id="league-team-name" placeholder="Team name" maxlength="24" aria-label="Team name">
        <button type="submit" class="primary">Add</button>
      </form>
      <div class="swatches" role="radiogroup" aria-label="Team colour">${TEAM_COLORS.map((c) =>
        `<button type="button" class="swatch ${c === LG.newTeamColor ? "on" : ""}" style="--sw:${c}" data-swatch="${c}" aria-label="Colour ${c}" role="radio" aria-checked="${c === LG.newTeamColor}"></button>`).join("")}</div>
      <div class="ro-teams">${teams.length ? teams.map((t) => {
        const members = t.player_ids.map((pid) => L.players[pid]).filter(Boolean);
        return `<div class="team-card" style="--tc:${esc(t.color)}">
          <div class="team-card-head">
            <span class="team-swatch"></span>
            <strong>${esc(t.name)}</strong>
            <span class="hint">${plural(members.length, "player")}</span>
            <button type="button" class="ghost icon-btn" data-del-team="${esc(t.id)}" aria-label="Delete ${esc(t.name)}">✕</button>
          </div>
          <div class="team-card-members">${members.length ? members.map((p) =>
            `<span class="mchip">${avatarHTML(p.name)}${esc(p.name)}</span>`).join("") : `<span class="hint">No players</span>`}</div>
        </div>`;
      }).join("") : `<div class="ro-none">No teams yet</div>`}</div>
    </section>
  </div>`;

  pane.querySelector("#form-add-player").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("league-player-name").value.trim();
    if (!name) return;
    try {
      await lapi(`/leagues/${L.id}/players`, "POST", { name });
      await refreshLeague();
      $("league-player-name").focus();
    } catch (err) { alertMsg(err.message); }
  };
  pane.querySelector("#form-add-team").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("league-team-name").value.trim();
    if (!name) return;
    try {
      await lapi(`/leagues/${L.id}/teams`, "POST", { name, color: LG.newTeamColor });
      LG.newTeamColor = null;
      await refreshLeague();
    } catch (err) { alertMsg(err.message); }
  };
  pane.querySelectorAll("[data-swatch]").forEach((b) => {
    b.onclick = () => {
      LG.newTeamColor = b.dataset.swatch;
      pane.querySelectorAll("[data-swatch]").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-checked", x === b ? "true" : "false");
      });
    };
  });
  pane.querySelectorAll("[data-team-of]").forEach((sel) => {
    sel.onchange = async () => {
      const pid = sel.dataset.teamOf;
      const cur = teamOf[pid];
      try {
        if (sel.value) await lapi(`/leagues/${L.id}/teams/${sel.value}/roster`, "POST", { player_id: pid });
        else if (cur) await lapi(`/leagues/${L.id}/teams/${cur.id}/roster/${pid}`, "DELETE");
      } catch (err) { alertMsg(err.message); }
      await refreshLeague();
    };
  });
  pane.querySelectorAll("[data-del-player]").forEach((b) => {
    b.onclick = async () => {
      const p = L.players[b.dataset.delPlayer];
      const n = gp[p.id] || 0;
      const ok = await confirmDialog({
        title: `Remove ${p.name}?`,
        body: n ? `${p.name} stays in the ${plural(n, "recorded game")} but leaves the roster and leaderboard.` : "",
        confirmLabel: "Remove",
      });
      if (!ok) return;
      try { await lapi(`/leagues/${L.id}/players/${p.id}`, "DELETE"); } catch (err) { alertMsg(err.message); }
      await refreshLeague();
    };
  });
  pane.querySelectorAll("[data-del-team]").forEach((b) => {
    b.onclick = async () => {
      const t = L.teams[b.dataset.delTeam];
      const ok = await confirmDialog({
        title: `Delete ${t.name}?`,
        body: t.player_ids.length ? `Its ${plural(t.player_ids.length, "player")} stay in the league without a team.` : "",
        confirmLabel: "Delete team",
      });
      if (!ok) return;
      try { await lapi(`/leagues/${L.id}/teams/${t.id}`, "DELETE"); } catch (err) { alertMsg(err.message); }
      await refreshLeague();
    };
  });
}

/* ---------- init ---------- */
fillRememberedNames();
renderSessions();
const params = new URLSearchParams(location.search);
if (["light", "dark", "system"].includes(params.get("theme") || "")) {
  applyTheme(params.get("theme"));
}
const joinCode = parseJoinCode();
if (params.get("rejoin") && params.get("token")) {
  resumeSession({
    game_id: params.get("rejoin"),
    token: params.get("token"),
    player_id: 0,
    name: params.get("name") || "",
  });
  ["rejoin", "token", "name"].forEach((k) => params.delete(k));
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
} else if (joinCode) {
  openJoinFromLink(joinCode);
} else {
  try {
    const active = JSON.parse(sessionStorage.getItem("wizard_active") || "null");
    if (active && active.token) resumeSession(active);
  } catch { /* ignore */ }
}
