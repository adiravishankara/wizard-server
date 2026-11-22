# Wizard

A FastAPI + WebSocket server for the Wizard card game, with a browser UI so friends can open one URL and play together.

This is not a serverless app. Games live in the server process’s memory, and each player keeps a live WebSocket. Restarting the server wipes every in-progress game.

## What is in this repo

- **Browser UI** at `/` (`app/static/`) — create/join a game, bid, play tricks, optional teams/leagues
- **HTTP + WebSocket API** under `/api/game` — join, rejoin, start, ready, action, `/ws/{game_id}/{player_id}`
- **Leagues** under `/api/league` — rosters, teams, recorded results, team standings and a player leaderboard. Stored in **Firebase Firestore** in production, or `data/wizard_league.json` locally (see [DEPLOY.md](DEPLOY.md))
- **Terminal client** `client.py` (needs `rich` and `websockets`)

There is no Docker-in-production image published, no JWT/OAuth, no Vercel Blob puzzles, and no player-profile CRUD. The old README described those; they are not here.

Gameplay rules live in `app/core/game.py` and are intentionally left alone.

## Bidding modes

Pick a mode when creating a game in the web UI:

| UI label | API value | What it does |
| --- | --- | --- |
| Sequential (normal) | `sequential` | Players bid in turn, left of dealer first. Bids are visible. |
| Simultaneous (home) | `simultaneous` | Anyone who has not bid yet may bid. Bids are visible as they come in. |
| Blind / Canadian (bids hidden until end of hand) | `secret` | Anyone who has not bid yet may bid. You see your own bid; everyone else's stays hidden until the hand (round) is over. |
| Canadian (last bidder can't even the total) | `canadian` | Sequential bidding, plus the last bidder cannot make the total bids equal the round number. Bids are visible. |

Supported player counts: **3–6**. “Blind” is the existing `secret` mode, not a separate engine variant.

## Run locally

Python 3.11+ (3.12 is fine).

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open http://127.0.0.1:8000

- Player 1: **Create game**, pick a bidding mode, share the 8-character code in the header
- Everyone else: **Join game** with that code and their own name (each person uses their own browser or tab)
- Player 1 hits **Start game** once at least 3 people have joined
- Bid, play highlighted cards, press **Ready** after each round

API docs: http://127.0.0.1:8000/docs  
Health check: http://127.0.0.1:8000/health

### Terminal client

```bash
pip install -e ".[client]"
python client.py
```

Point it at another host with `WIZARD_API_URL` and `WIZARD_WS_URL`. If several clients share a folder, sessions are stored together in `wizard_session.json` (one entry per player, not one file overwrite). Override the file with `WIZARD_SESSION_FILE`.

## Deploy (Render)

This needs a **long-running** process (WebSockets + in-memory games). Serverless function hosts are a poor fit.

The repo includes a `Dockerfile` and a Render blueprint (`render.yaml`).

**What Adithya needs to do:**

1. Create a [Render](https://render.com) account (GitHub login is easiest) and grant it access to `adiravishankara/wizard-server`.
2. In the Render dashboard: **New + → Blueprint**, pick this repo, and apply the `wizard` web service.
   - Or **New + → Web Service**, connect the repo, runtime **Docker**, and leave the start command to the Dockerfile (`uvicorn` on `$PORT`).
3. Leagues are stored in Firebase Firestore. Follow [DEPLOY.md](DEPLOY.md) to create the Firebase project and paste the service-account key into `FIREBASE_CREDENTIALS_B64` when Render asks. Render sets `PORT`.
4. Check `https://<your-service>.onrender.com/health` shows `"league_store": "firestore"`.
5. After the first deploy, copy the public URL (e.g. `https://wizard-xxxx.onrender.com`) and put it in this README so friends have a stable link.

Free Render web services **sleep after idle time** and **lose all in-memory games** when they sleep or restart. League data and recorded results are in Firestore and survive. For a game night, open the URL once to wake it, then keep it open. A paid instance stays up.

Any other container host (Fly.io, Railway) works the same way: build the Dockerfile, bind to `$PORT`, and set the Firebase variables from [DEPLOY.md](DEPLOY.md).

```bash
docker build -t wizard .
docker run --rm -p 8000:8000 -e PORT=8000 -e LEAGUE_STORE=json wizard
```

## Leagues

Open **Leagues** in the top bar.

- **Players** — leaderboard: games, wins (shared top scores count as ties), average and best score, and bid accuracy (rounds where tricks matched the bid) for every league player, on a team or not.
- **Teams** — team standings from recorded results.
- **Games** — every recorded result; open one for the winner, players, scores, the points journey chart and the hand-by-hand table (trump, dealer, bid/tricks, points and running total). **Add result** enters a game played elsewhere, with final scores only or score by score for each hand; results can be edited or deleted.
- **Roster** — add players and teams, move players between teams.

In a game lobby, pick a league and each seat is matched to a league player by name (change any match from the list). Teams come from the league rosters, so it does not matter who sits where. At game over, the panel shows the team result and **Record to league** saves the full summary.

The host (the player who created the game) can **Shuffle seats** in the lobby, or have seats shuffled when the game starts. At game over, **Rematch** opens a new lobby with the same bidding mode, league and teams; the others click **Join rematch**, and the seat order is shuffled at start unless the box is unticked.

## How friends join

1. One person opens the deployed URL (or localhost) and clicks **Create game**.
2. They send the game code shown at the top of the table.
3. Everyone else opens the **same URL**, enters that code + their name, **Join game**.
4. After 3–6 players are in the lobby, start.

Reconnect: refresh the tab, or leave and click **Resume** on that session. Each player’s token is stored in *their* browser (`localStorage`, keyed by game + player). The server keeps every player’s token on the in-memory game; a restart still wipes it.

## Tests

```bash
pip install -e ".[dev]"
pytest -q
```

Covers 3- and 5-player games, all four bidding modes through at least two rounds, every player rejoining after a drop, the trump rules, and leagues (JSON and faked Firestore storage, stats, results, seat links). Tests never contact Firebase.

## Limitations

- **Games are in memory only.** Deploy/restart/sleep = everyone is kicked and cannot rejoin that game.
- **Leagues persist** to Firestore (or `data/wizard_league.json` locally). A finished game is saved when someone records it to a league; unrecorded games are not saved.
- The league cache assumes **one server instance**; don't scale the Render service out.
- **No login.** Anyone with the game code can join until the game starts (max 6).
- **Blind** is `BiddingMode.SECRET` in the API (labeled **Blind / Canadian** in the UI). Other players’ bids are hidden until the hand ends; you still see your own. The separate **Canadian (even-total)** mode is sequential bidding with the last-bidder restriction, and those bids are visible.
- Standard published Wizard often applies the “last bidder cannot make totals even” rule to normal play. Here that restriction is **only** on the Canadian even-total mode; sequential/normal does not enforce it.
