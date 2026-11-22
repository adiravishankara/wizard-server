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
function rankLabel(r) {
  return r === 11 ? "J" : r === 12 ? "Q" : r === 13 ? "K" : r === 14 ? "A" : String(r);
}
function cardHTML(card, opts = {}) {
  const who = opts.who || "";
  const extra = opts.cls || "";
  const attrs = opts.attrs || "";
  if (card.type === "wizard") {
    return `<div class="playing-card special wizard ${extra}" ${attrs}>
      <span class="c-corner tl">W</span>
      <span class="c-center special-label">WIZARD</span>
      <span class="c-corner br">W</span>${who}</div>`;
  }
  if (card.type === "jester") {
    return `<div class="playing-card special jester ${extra}" ${attrs}>
      <span class="c-corner tl">JE</span>
      <span class="c-center special-label">JESTER</span>
      <span class="c-corner br">JE</span>${who}</div>`;
  }
  const red = (card.suit === "H" || card.suit === "D");
  const rl = rankLabel(card.rank);
  const s = SUIT_SYM[card.suit] || "";
  const center = card.rank >= 11
    ? `<span class="c-face">${esc(rl)}</span><span class="c-pip">${s}</span>`
    : `<span class="c-pip big">${s}</span>`;
  return `<div class="playing-card ${red ? "red" : "black"} ${extra}" ${attrs}>
    <span class="c-corner tl"><b>${esc(rl)}</b><br>${s}</span>
    <span class="c-center">${center}</span>
    <span class="c-corner br"><b>${esc(rl)}</b><br>${s}</span>${who}</div>`;
}
function layoutFan(container) {
  const cards = [...container.querySelectorAll(".playing-card")];
  const n = cards.length;
  if (!n) return;
  const maxW = container.clientWidth || 360;
  const w = cards[0].getBoundingClientRect().width || 82;
  const step = n === 1 ? 0 : Math.min(w - 16, Math.max(16, (maxW - w - 8) / (n - 1)));
  cards.forEach((el, i) => {
    el.style.marginLeft = i === 0 ? "0px" : `${(step - w).toFixed(1)}px`;
    el.style.zIndex = String(i + 1);
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
function playerBadge(st, i) {
  const name = st.players[i];
  const bid = bidShown(st, i);
  const won = st.trick_wins[i] ?? 0;
  const trump = st.trump_suit ? SUIT_SYM[st.trump_suit] : "";
  const trumpRed = st.trump_suit === "H" || st.trump_suit === "D";
  const turn = st.current_player === i && st.phase !== "lobby" && st.phase !== "round_over";
  const me = st.player_id === i;
  const stat = st.phase === "lobby" ? "" : `<div class="pbadge-stat">${won}/${bid}</div>`;
  return `<div class="pbadge ${turn ? "turn" : ""} ${me ? "me" : ""}">
    <div class="avatar" style="background:hsl(${avatarHue(name)} 62% 42%)">${esc(initials(name))}</div>
    <div>
      <div class="pbadge-name">${esc(name)}</div>
      <div class="pbadge-meta">${st.scores[i]} pts${i === st.dealer_idx && st.phase !== "lobby" ? " · dealer" : ""}</div>
    </div>
    ${stat}
    <div class="pbadge-trump ${trumpRed ? "red" : ""}">${trump}</div>
  </div>`;
}
function statusText(st) {
  const name = st.players[st.current_player] ?? "";
  const me = st.player_id === st.current_player;
  if (st.phase === "lobby") return "Waiting for players…";
  if (st.phase === "waiting_trump") {
    return me ? "Your turn to choose trump" : `Waiting for ${name} to choose trump…`;
  }
  if (st.phase === "bidding") {
    const open = st.bidding_mode === "simultaneous" || st.bidding_mode === "secret";
    const myBid = st.bids[String(st.player_id)] ?? st.bids[st.player_id];
    if (open) {
      if (myBid === null || myBid === undefined) return "Your turn to bid";
      return "Waiting for others to bid…";
    }
    return me ? "Your turn to bid" : `Waiting for ${name} to bid…`;
  }
  if (st.phase === "playing") {
    if (st.trick_complete) return `Trick complete — ${name} leads next`;
    return me ? "Your turn to play" : `Waiting for ${name} to play…`;
  }
  if (st.phase === "round_over") return "Round over";
  if (st.phase === "game_over") return "Game over";
  return "";
}

/* ----- main render ----- */
function renderGame() {
  const st = S.state;
  if (!st) return;
  const me = st.player_id;

  const roundNo = st.phase === "round_over" && st.current_round > 1
    ? st.current_round - 1
    : st.current_round;
  $("g-round").textContent = `R${roundNo}`;
  $("g-round").classList.toggle("hidden", st.phase === "lobby");
  const trumpEl = $("g-trump");
  if (st.phase === "waiting_trump") {
    trumpEl.textContent = "Choosing trump";
    trumpEl.classList.remove("none");
  } else if (st.trump_suit) {
    const red = st.trump_suit === "H" || st.trump_suit === "D";
    trumpEl.innerHTML = `Trump <span class="${red ? "red" : ""}">${SUIT_SYM[st.trump_suit]}</span>`;
    trumpEl.classList.remove("none");
  } else {
    trumpEl.textContent = "No trump";
    trumpEl.classList.add("none");
  }
  $("status-line").textContent = statusText(st);
  trumpEl.classList.toggle("hidden", st.phase === "lobby");

  const isLobby = st.phase === "lobby";
  $("game-screen").classList.toggle("in-lobby", isLobby);
  const scoresView = st.phase === "round_over" || st.phase === "game_over";
  $("lobby-panel").classList.toggle("hidden", !isLobby);
  $("table-panel").classList.toggle("hidden", isLobby || scoresView);
  $("hand-panel").classList.toggle("hidden", isLobby || scoresView || st.phase === "waiting_trump");

  if (isLobby) { renderLobby(st); }

  const myBid = st.bids[String(me)] ?? st.bids[me];
  const canBid = st.phase === "bidding" && (myBid === null || myBid === undefined) &&
    (st.bidding_mode !== "sequential" && st.bidding_mode !== "canadian" || st.current_player === me);
  $("bid-panel").classList.toggle("hidden", !canBid);
  if (canBid) {
    S.bidVal = Math.min(S.bidVal, st.current_round);
    $("bid-value").textContent = S.bidVal;
    $("bid-info").textContent = `Bid 0–${st.current_round}`;
  }

  const choosingTrump = st.phase === "waiting_trump";
  $("trump-panel").classList.toggle("hidden", !choosingTrump);
  if (choosingTrump) {
    const chooser = st.players[st.current_player] ?? "someone";
    $("trump-flip").innerHTML = cardHTML({ type: "wizard" });
    $("trump-caption").textContent = "Wizard flipped";
    const mine = st.current_player === me;
    $("trump-actions").classList.toggle("hidden", !mine);
    $("trump-wait").classList.toggle("hidden", mine);
    $("trump-wait").textContent = `${chooser} is choosing trump…`;
  }

  const others = st.players.map((_, i) => i).filter((i) => i !== me);
  $("opponents").innerHTML = others.map((i) => playerBadge(st, i)).join("");
  $("you-badge").innerHTML = playerBadge(st, me);

  const trick = $("trick-area");
  if (st.phase === "waiting_trump") {
    trick.innerHTML = "";
  } else if (st.current_trick.length) {
    trick.innerHTML = st.current_trick.map(([pi, c]) =>
      cardHTML(c, { who: `<span class="who">${esc(st.players[pi])}</span>` })).join("");
  } else if (st.flip && st.flip.kind === "jester" && st.phase === "bidding") {
    trick.innerHTML = `<div class="flip-on-table">${cardHTML({ type: "jester" })}<span class="who">No trump</span></div>`;
  } else {
    trick.innerHTML = `<span class="hint">No cards played yet.</span>`;
  }
  trick.classList.toggle("hidden", !trick.innerHTML);

  const myTurn = st.phase === "playing" && st.current_player === me && !st.trick_complete;
  if (!myTurn) S.selected = null;
  if (S.selected != null && !st.legal_moves.includes(S.selected)) S.selected = null;
  const hand = $("hand");
  hand.innerHTML = st.hand.length
    ? st.hand.map((c, i) => {
        const legal = myTurn && st.legal_moves.includes(i);
        const cls = [
          !myTurn ? "" : (legal ? "legal" : "illegal"),
          S.selected === i ? "selected" : "",
        ].join(" ");
        return cardHTML(c, { cls, attrs: `data-card="${i}"` });
      }).join("")
    : `<span class="hint">Waiting for the deal…</span>`;
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
  if (S.selected != null) {
    const c = st.hand[S.selected];
    const lab = c.type === "wizard" ? "Wizard" : c.type === "jester" ? "Jester"
      : `${rankLabel(c.rank)}${SUIT_SYM[c.suit] || ""}`;
    playBtn.textContent = `Play ${lab}`;
  } else {
    playBtn.textContent = "Play card";
  }

  $("roundover-panel").classList.toggle("hidden", st.phase !== "round_over");
  if (st.phase === "round_over") {
    $("round-scores").innerHTML = st.players.map((p, i) =>
      `<div class="score-row ${i === me ? "me" : ""}">
        <div><strong>${esc(p)}</strong>
          <span class="bid-chip">${st.trick_wins[i] ?? 0}/${bidShown(st, i)}</span></div>
        <div><strong>${st.scores[i]}</strong></div>
      </div>`).join("");
  }
  const over = st.phase === "game_over";
  $("gameover-panel").classList.toggle("hidden", !over);
  if (over) renderGameOver(st);

  renderScores(st);
  refreshTeamScores();
}

function phaseLabel(p) {
  return { lobby: "Lobby", bidding: "Bidding", playing: "Playing",
    waiting_trump: "Trump?", round_over: "Round over", game_over: "Game over" }[p] || p;
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

$("bid-minus").onclick = () => { S.bidVal = Math.max(0, S.bidVal - 1); $("bid-value").textContent = S.bidVal; };
$("bid-plus").onclick = () => {
  const max = S.state ? S.state.current_round : 0;
  S.bidVal = Math.min(max, S.bidVal + 1); $("bid-value").textContent = S.bidVal;
};
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
function bidShown(st, i) {
  const bid = st.bids[String(i)] ?? st.bids[i];
  const hideOthers = st.bidding_mode === "secret" &&
    (st.phase === "bidding" || st.phase === "playing") &&
    i !== st.player_id;
  if (hideOthers || bid === null || bid === undefined) return "?";
  return bid;
}

function renderScores(st) {
  const me = st.player_id;
  $("scores").innerHTML = st.players.map((p, i) => {
    return `<div class="score-row ${i === me ? "me" : ""}">
      <div><strong>${esc(p)}</strong>
        <span class="bid-chip">bid ${bidShown(st, i)}</span>
        <span class="bid-chip">won ${st.trick_wins[i] ?? 0}</span>
      </div>
      <div><strong>${st.scores[i]}</strong></div>
    </div>`;
  }).join("");
}

window.addEventListener("resize", () => {
  if (S.state) layoutFan($("hand"));
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
