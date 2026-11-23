"""League HTTP API: manual results, edit/delete, seat links, live recording."""
from app.models.game import GamePhase
from app.services.game_store import games
from app.services.league_store import JsonBackend, LeagueStore

API = "/api/league"


def _league(client, players=("Ada", "Bea", "Cal", "Dee", "Eli"), teams=None):
    lg = client.post(f"{API}/leagues", json={"name": "Friday Night Wizards"}).json()
    ids = {}
    for name in players:
        ids[name] = client.post(f"{API}/leagues/{lg['id']}/players", json={"name": name}).json()["id"]
    team_ids = {}
    for tname, members in (teams or {}).items():
        t = client.post(f"{API}/leagues/{lg['id']}/teams", json={"name": tname, "color": "#123456"}).json()
        client.put(f"{API}/leagues/{lg['id']}/teams/{t['id']}/roster",
                   json={"player_ids": [ids[m] for m in members]})
        team_ids[tname] = t["id"]
    return lg["id"], ids, team_ids


def test_duplicate_player_names_are_rejected(client):
    lid, _, _ = _league(client)
    res = client.post(f"{API}/leagues/{lid}/players", json={"name": "  ada "})
    assert res.status_code == 409


def test_manual_result_add_edit_delete(client, fresh_league_store):
    lid, ids, teams = _league(client, teams={"Hats": ["Ada", "Bea"]})
    body = {
        "played_at": "2026-11-20", "bidding_mode": "canadian", "rounds_played": 15,
        "players": [
            {"league_player_id": ids["Ada"], "score": 120, "bids_made": 11},
            {"league_player_id": ids["Bea"], "score": 120},
            {"league_player_id": ids["Cal"], "score": 40, "bids_made": 9},
            {"name": "Fay", "score": -30},
        ],
        "notes": "Cabin night",
    }
    rec = client.post(f"{API}/leagues/{lid}/games", json=body).json()
    assert rec["source"] == "manual" and rec["played_at"].startswith("2026-11-20")
    assert rec["winner_names"] == ["Ada", "Bea"] and rec["player_tie"] is True
    assert rec["team_scores"] == {teams["Hats"]: 240}
    fay = next(p for p in rec["players"] if p["name"] == "Fay")
    assert fay["league_player_id"] and fay["team_id"] is None
    assert client.get(f"{API}/leagues/{lid}").json()["players"][fay["league_player_id"]]["name"] == "Fay"

    board = {r["name"]: r for r in client.get(f"{API}/leagues/{lid}/leaderboard").json()}
    assert board["Fay"]["games_played"] == 1 and board["Fay"]["team_id"] is None
    assert board["Ada"]["ties"] == 1 and board["Ada"]["bid_accuracy"] == round(11 / 15, 3)

    body["players"][1]["score"] = 100
    edited = client.put(f"{API}/leagues/{lid}/games/{rec['id']}", json=body).json()
    assert edited["id"] == rec["id"] and edited["edited_at"]
    assert edited["winner_names"] == ["Ada"] and edited["player_tie"] is False

    persisted = LeagueStore(JsonBackend(fresh_league_store.backend.path)).get_record(lid, rec["id"])
    assert persisted.players[1].score == 100 and persisted.notes == "Cabin night"

    assert client.delete(f"{API}/leagues/{lid}/games/{rec['id']}").status_code == 200
    assert client.get(f"{API}/leagues/{lid}/games/{rec['id']}").status_code == 404


def test_manual_result_validation(client):
    lid, ids, _ = _league(client)
    base = {"rounds_played": 10, "players": [
        {"league_player_id": ids["Ada"], "score": 10},
        {"league_player_id": ids["Bea"], "score": 0},
    ]}
    assert client.post(f"{API}/leagues/{lid}/games", json=base).status_code == 400
    dup = {**base, "players": base["players"] + [{"name": "ada", "score": 5}]}
    assert "twice" in client.post(f"{API}/leagues/{lid}/games", json=dup).json()["detail"]
    too_many = {**base, "players": base["players"] + [{"league_player_id": ids["Cal"], "score": 0, "bids_made": 11}]}
    assert client.post(f"{API}/leagues/{lid}/games", json=too_many).status_code == 400
    names_before = len(client.get(f"{API}/leagues/{lid}").json()["players"])
    bad_mode = {**base, "bidding_mode": "speed", "players": base["players"] + [{"name": "New", "score": 0}]}
    assert client.post(f"{API}/leagues/{lid}/games", json=bad_mode).status_code == 400
    assert len(client.get(f"{API}/leagues/{lid}").json()["players"]) == names_before


def _join(client, names):
    host = client.post("/api/game/join", json={"name": names[0], "bidding_mode": "simultaneous"}).json()
    for n in names[1:]:
        client.post("/api/game/join", json={"name": n, "game_id": host["game_id"]})
    return host["game_id"]


def _finish(game_id, scores):
    game = games[game_id]
    n = len(game.state.players)
    game.state.phase = GamePhase.GAME_OVER
    game.state.current_round = 2
    game.state.scores = list(scores)
    game.history = [
        {"round": 1, "bids": {str(i): 0 for i in range(n)}, "tricks": [1] + [0] * (n - 1),
         "deltas": [-10] + [20] * (n - 1), "scores": [-10] + [20] * (n - 1)},
        {"round": 2, "bids": {str(i): 1 for i in range(n)}, "tricks": [1, 1] + [0] * (n - 2),
         "deltas": [], "scores": list(scores)},
    ]


def test_seat_link_by_selection_and_team_derivation(client):
    lid, ids, teams = _league(client, teams={"Hats": ["Ada", "Cal"], "Owls": ["Bea"]})
    gid = _join(client, ["cal", "Guesty", "Ada"])

    suggestion = client.get(f"{API}/games/{gid}/link/suggest", params={"league_id": lid}).json()
    assert [s["league_player_id"] for s in suggestion["seats"]] == [ids["Cal"], None, ids["Ada"]]

    res = client.put(f"{API}/games/{gid}/link", json={
        "league_id": lid, "seats": {"0": ids["Cal"], "1": ids["Bea"], "2": ids["Ada"]},
    }).json()
    by_name = {t["name"]: t["player_indices"] for t in res["teams"]}
    assert by_name == {"Hats": [0, 2], "Owls": [1]}
    assert client.get(f"{API}/games/{gid}/teams").json()[0]["league_team_id"] == teams["Hats"]

    twice = client.put(f"{API}/games/{gid}/link", json={
        "league_id": lid, "seats": {"0": ids["Ada"], "1": ids["Ada"]},
    })
    assert twice.status_code == 400


def test_record_live_game_persists_summary_and_blocks_duplicates(client, fresh_league_store):
    lid, ids, teams = _league(client, teams={"Hats": ["Ada", "Bea"], "Owls": ["Cal"]})
    gid = _join(client, ["Bea", "Cal", "Visitor", "Ada"])
    client.put(f"{API}/games/{gid}/link", json={
        "league_id": lid, "seats": {"0": ids["Bea"], "1": ids["Cal"], "2": ids["Dee"], "3": ids["Ada"]},
    })
    assert client.post(f"{API}/leagues/{lid}/record", json={"game_id": gid}).status_code == 400

    _finish(gid, [70, 90, 10, -20])
    rec = client.post(f"{API}/leagues/{lid}/record", json={"game_id": gid}).json()
    assert rec["bidding_mode"] == "simultaneous" and rec["rounds_played"] == 2
    assert [p["name"] for p in rec["players"]] == ["Bea", "Cal", "Dee", "Ada"]
    assert rec["team_scores"] == {teams["Hats"]: 50, teams["Owls"]: 90}
    assert rec["winner_team_id"] == teams["Owls"] and rec["winner_names"] == ["Cal"]
    assert [p["bids_made"] for p in rec["players"]] == [1, 2, 1, 1]

    link = client.get(f"{API}/games/{gid}/link").json()
    assert link["recorded_record_id"] == rec["id"]
    assert client.post(f"{API}/leagues/{lid}/record", json={"game_id": gid}).status_code == 400
    assert client.put(f"{API}/games/{gid}/link", json={"league_id": lid}).status_code == 400

    games.clear()
    restarted = LeagueStore(JsonBackend(fresh_league_store.backend.path))
    saved = restarted.get_record(lid, rec["id"])
    assert [(p.name, p.score) for p in saved.players] == [("Bea", 70), ("Cal", 90), ("Dee", 10), ("Ada", -20)]
    assert len(saved.rounds) == 2


def test_unlinked_game_records_by_name_match(client):
    lid, ids, _ = _league(client, teams={"Hats": ["Ada"]})
    gid = _join(client, ["ada", "Bea", "Stranger"])
    _finish(gid, [30, 10, 50])
    rec = client.post(f"{API}/leagues/{lid}/record", json={"game_id": gid}).json()
    assert [p["league_player_id"] for p in rec["players"]] == [ids["Ada"], ids["Bea"], None]
    assert rec["players"][0]["name"] == "Ada"
    board = {r["name"]: r for r in client.get(f"{API}/leagues/{lid}/leaderboard").json()}
    assert board["Ada"]["games_played"] == 1 and "Stranger" not in board


def test_league_ui_is_served_without_browser_dialogs(client):
    html = client.get("/").text
    for el in ("tab-players", "tab-teams", "tab-games", "tab-roster", "btn-add-result",
               "link-league", "btn-record", "btn-view-standings", 'id="confirm"', 'id="modal"'):
        assert el in html
    res = client.get("/static/app.js")
    assert res.status_code == 200
    js = res.text
    assert "confirm(" not in js.replace("confirmDialog(", "")
    assert "alert(" not in js.replace("Alert(", "").replace("alertMsg(", "")


def test_game_over_and_lobby_ui_hooks_are_served(client):
    html = client.get("/").text
    for el in ("go-chart", "go-rematch", "btn-shuffle", "shuffle-on-start", "lobby-waiting",
               '<script src="/static/chart.js">'):
        assert el in html
    chart = client.get("/static/chart.js")
    assert chart.status_code == 200
    assert "prefers-reduced-motion" in chart.text


def _hand(dealer, trump, *lines):
    return {"dealer": dealer, "trump": trump,
            "lines": [{"points": p, "bid": b, "tricks": t} for p, b, t in lines]}


def test_manual_result_with_per_hand_scores(client):
    lid, ids, _ = _league(client, players=("Ada", "Bea", "Cal"))
    body = {
        "played_at": "2026-11-20", "bidding_mode": "sequential",
        "players": [{"league_player_id": ids["Ada"]}, {"league_player_id": ids["Bea"], "score": 0},
                    {"name": "Cal"}],
        "rounds": [
            _hand(0, "H", (30, 1, 1), (20, 0, 0), (-10, 1, 0)),
            _hand(1, "", (-10, 2, 1), (40, 1, 1), (20, 0, 0)),
            _hand(2, "S", (-20, 0, 2), (-60, 3, 0), (50, 1, 1)),
        ],
    }
    rec = client.post(f"{API}/leagues/{lid}/games", json=body).json()
    assert rec["final_only"] is False and rec["rounds_played"] == 3
    assert [(p["name"], p["score"], p["place"], p["bids_made"], p["rounds_bid"]) for p in rec["players"]] == [
        ("Ada", 0, 2, 1, 3), ("Bea", 0, 2, 2, 3), ("Cal", 60, 1, 2, 3)]
    r2 = rec["rounds"][1]
    assert (r2["round"], r2["cards_dealt"], r2["dealer"], r2["trump"]) == (2, 2, "Bea", None)
    assert [(ln["name"], ln["points"], ln["total"]) for ln in r2["players"]] == [
        ("Ada", -10, 20), ("Bea", 40, 60), ("Cal", 20, 10)]

    stored = client.get(f"{API}/leagues/{lid}/games/{rec['id']}").json()
    assert stored["rounds"] == rec["rounds"]

    # Editing other fields without sending hands keeps them while the totals still match.
    edit = {"played_at": "2026-11-21", "players": [{"league_player_id": p["league_player_id"], "score": p["score"]}
                                                    for p in rec["players"]]}
    kept = client.put(f"{API}/leagues/{lid}/games/{rec['id']}", json=edit).json()
    assert kept["final_only"] is False and len(kept["rounds"]) == 3
    # Changing a final score without hands turns it into a final-only result.
    edit["players"][0]["score"] = 100
    final_only = client.put(f"{API}/leagues/{lid}/games/{rec['id']}", json=edit).json()
    assert final_only["final_only"] is True and final_only["rounds"] == []


def test_per_hand_input_is_validated(client):
    lid, ids, _ = _league(client, players=("Ada", "Bea", "Cal"))
    players = [{"league_player_id": ids[n]} for n in ("Ada", "Bea", "Cal")]
    bad_total = {"players": [dict(players[0], score=99), players[1], players[2]],
                 "rounds": [_hand(0, "H", (30, 1, 1), (20, 0, 0), (-10, 1, 0))]}
    res = client.post(f"{API}/leagues/{lid}/games", json=bad_total)
    assert res.status_code == 400 and "doesn't match" in res.json()["detail"]
    short = {"players": players, "rounds": [{"lines": [{"points": 20}, {"points": 20}]}]}
    assert client.post(f"{API}/leagues/{lid}/games", json=short).status_code == 400
    too_many_tricks = {"players": players, "rounds": [_hand(0, "H", (30, 1, 2), (20, 0, 0), (-10, 1, 0))]}
    assert client.post(f"{API}/leagues/{lid}/games", json=too_many_tricks).status_code == 400
    no_score = {"players": players}
    assert client.post(f"{API}/leagues/{lid}/games", json=no_score).status_code == 400
    final = client.post(f"{API}/leagues/{lid}/games", json={
        "players": [dict(p, score=s) for p, s in zip(players, (50, 10, -20))]}).json()
    assert final["final_only"] is True and final["rounds"] == []
    assert len(client.get(f"{API}/leagues/{lid}/games").json()) == 1
