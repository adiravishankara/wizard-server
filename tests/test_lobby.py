"""Lobby seat shuffle and rematch, layered over the engine."""
import json
import random

import httpx

from app.models.game import GamePhase
from app.services.game_store import games
from app.services.lobby import shuffle_seats
from app.services.tracked_game import TrackedWizardGame
from test_multiplayer import Player, drain, seat

NAMES = ["Ada", "Bea", "Cal", "Dee"]


def _rejoin(http, game_id, token):
    res = http.post("/api/game/rejoin", json={"game_id": game_id, "token": token})
    assert res.status_code == 200, res.text
    return res.json()


def _finish(game_id):
    games[game_id].state.phase = GamePhase.GAME_OVER


def test_shuffle_seats_permutes_names_and_tokens():
    game = TrackedWizardGame("unit", "sequential")
    tokens = {}
    for name in NAMES:
        seat_idx = game.add_player(name)
        tokens[name] = f"tok-{name}"
        game.state.player_tokens[tokens[name]] = seat_idx
    old_to_new = shuffle_seats(game, random.Random(3))
    assert sorted(game.state.players) == sorted(NAMES) and game.state.players != NAMES
    for name in NAMES:
        seat_idx = game.state.player_tokens[tokens[name]]
        assert game.state.players[seat_idx] == name
        assert old_to_new[NAMES.index(name)] == seat_idx
    game.state.phase = GamePhase.BIDDING
    try:
        shuffle_seats(game)
    except ValueError:
        pass
    else:
        raise AssertionError("shuffle must be refused once the game started")


def test_host_shuffle_moves_sockets_tokens_and_league_links(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], NAMES)
        gid = players[0].game_id
        assert players[0].state["host"] == 0

        lg = http.post("/api/league/leagues", json={"name": "L"}).json()
        pid = {n: http.post(f"/api/league/leagues/{lg['id']}/players", json={"name": n}).json()["id"] for n in NAMES}
        http.put(f"/api/league/games/{gid}/link",
                 json={"league_id": lg["id"], "seats": {str(i): pid[n] for i, n in enumerate(NAMES)}})

        assert http.post(f"/api/game/{gid}/shuffle", json={"token": players[1].token}).status_code == 403
        res = http.post(f"/api/game/{gid}/shuffle", json={"token": players[0].token})
        assert res.status_code == 200, res.text
        order = res.json()["players"]
        assert sorted(order) == sorted(NAMES) and order != NAMES

        drain(players)
        for p in players:
            # Each socket now receives the view for its owner's new seat.
            assert p.state["player_name"] == p.name
            assert p.state["players"] == order
            assert p.state["seats_shuffled"] is True
            assert _rejoin(http, gid, p.token)["player_id"] == order.index(p.name)
        assert players[0].state["host"] == order.index("Ada")

        link = http.get(f"/api/league/games/{gid}/link").json()
        assert all(s["league_player_id"] == pid[s["name"]] for s in link["seats"])

        assert http.post(f"/api/game/{gid}/start").status_code == 200
        assert http.post(f"/api/game/{gid}/shuffle", json={"token": players[0].token}).status_code == 400
        for p in players:
            p.disconnect()


def test_rematch_moves_opted_in_players_with_same_settings(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], NAMES, mode="secret")
        gid = players[0].game_id
        lg = http.post("/api/league/leagues", json={"name": "L"}).json()
        pid = {n: http.post(f"/api/league/leagues/{lg['id']}/players", json={"name": n}).json()["id"] for n in NAMES}
        team = http.post(f"/api/league/leagues/{lg['id']}/teams", json={"name": "Hats", "color": "#7c4dff"}).json()
        http.put(f"/api/league/leagues/{lg['id']}/teams/{team['id']}/roster",
                 json={"player_ids": [pid["Bea"], pid["Dee"]]})
        sug = http.get(f"/api/league/games/{gid}/link/suggest", params={"league_id": lg["id"]}).json()
        http.put(f"/api/league/games/{gid}/link", json={
            "league_id": lg["id"], "seats": {str(s["seat"]): s["league_player_id"] for s in sug["seats"]}})

        early = http.post(f"/api/game/{gid}/rematch", json={"token": players[1].token})
        assert early.status_code == 400
        _finish(gid)

        bea = http.post(f"/api/game/{gid}/rematch", json={"token": players[1].token, "shuffle": True}).json()
        new_id = bea["game_id"]
        assert new_id != gid and bea["player_id"] == 0 and bea["name"] == "Bea"
        assert games[new_id].state.bidding_mode == games[gid].state.bidding_mode
        again = http.post(f"/api/game/{gid}/rematch", json={"token": players[1].token}).json()
        assert again == bea

        drain(players)
        assert players[0].state["rematch"] == {"game_id": new_id, "joined": [1], "started": False, "open": True}

        ada = http.post(f"/api/game/{gid}/rematch/join", json={"token": players[0].token}).json()
        cal = http.post(f"/api/game/{gid}/rematch/join", json={"token": players[2].token}).json()
        assert (ada["game_id"], cal["game_id"]) == (new_id, new_id)
        assert games[new_id].state.players == ["Bea", "Ada", "Cal"]

        bea_p = Player(new_id, bea["player_id"], bea["token"], "Bea").connect(live_server["ws"])
        assert bea_p.state["host"] == 0
        assert bea_p.state["rematch_of"] == gid and bea_p.state["waiting_for"] == ["Dee"]
        assert bea_p.state["shuffle_on_start"] is True

        link = http.get(f"/api/league/games/{new_id}/link").json()
        assert link["league_id"] == lg["id"]
        assert {s["name"]: s["league_player_id"] for s in link["seats"]} == {n: pid[n] for n in ("Bea", "Ada", "Cal")}
        assert [t["player_indices"] for t in link["teams"] if t["league_team_id"] == team["id"]] == [[0]]

        assert http.post(f"/api/game/{new_id}/lobby-settings",
                         json={"token": ada["token"], "shuffle_on_start": False}).status_code == 403

        assert http.post(f"/api/game/{new_id}/start").status_code == 200
        state = games[new_id].state
        assert sorted(state.players) == ["Ada", "Bea", "Cal"]
        for sess in (bea, ada, cal):
            back = _rejoin(http, new_id, sess["token"])
            assert state.players[back["player_id"]] == sess["name"]
        hats_seat = state.players.index("Bea")
        link = http.get(f"/api/league/games/{new_id}/link").json()
        assert [t["player_indices"] for t in link["teams"] if t["league_team_id"] == team["id"]] == [[hats_seat]]

        late = http.post(f"/api/game/{gid}/rematch/join", json={"token": players[3].token})
        assert late.status_code == 400
        # Old sessions still rejoin the finished game.
        assert _rejoin(http, gid, players[3].token)["name"] == "Dee"
        bea_p.disconnect()
        for p in players:
            p.disconnect()


def test_rematch_join_needs_a_rematch_and_a_valid_token(client):
    host = client.post("/api/game/join", json={"name": "Ada"}).json()
    gid = host["game_id"]
    for name in NAMES[1:3]:
        client.post("/api/game/join", json={"name": name, "game_id": gid})
    _finish(gid)
    assert client.post(f"/api/game/{gid}/rematch/join", json={"token": host["token"]}).status_code == 404
    assert client.post(f"/api/game/{gid}/rematch", json={"token": "nope"}).status_code == 403
    state = json.loads(json.dumps(client.post(f"/api/game/{gid}/rematch", json={"token": host["token"]}).json()))
    assert state["name"] == "Ada"
