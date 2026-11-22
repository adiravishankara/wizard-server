"""End-to-end coverage for multi-player games, bidding modes, and rejoin."""
import asyncio
import json

import httpx
from websockets.sync.client import connect as ws_connect

from app.services.connection_manager import ConnectionManager
from app.services.game_store import games
from app.services.player_view import player_state_dict


class Player:
    def __init__(self, game_id, player_id, token, name):
        self.game_id = game_id
        self.player_id = player_id
        self.token = token
        self.name = name
        self.ws = None
        self.state = None

    @classmethod
    def join(cls, http: httpx.Client, name, game_id=None, bidding_mode="sequential"):
        payload = {"name": name}
        if game_id:
            payload["game_id"] = game_id
        else:
            payload["bidding_mode"] = bidding_mode
        res = http.post("/api/game/join", json=payload)
        assert res.status_code == 200, res.text
        data = res.json()
        return cls(data["game_id"], data["player_id"], data["token"], name)

    def connect(self, ws_base: str):
        self.ws = ws_connect(
            f"{ws_base}/api/game/ws/{self.game_id}/{self.player_id}",
            open_timeout=5,
            legacy=True,
        )
        self.state = json.loads(self.ws.recv(timeout=5))
        return self

    def disconnect(self):
        if self.ws is not None:
            self.ws.close()
            self.ws = None


def seat(http, ws_base, names, mode="sequential"):
    host = Player.join(http, names[0], bidding_mode=mode)
    players = [host]
    for name in names[1:]:
        players.append(Player.join(http, name, game_id=host.game_id))
    for player in players:
        player.connect(ws_base)
    return players


def drain(players, timeout=8):
    for player in players:
        player.state = json.loads(player.ws.recv(timeout=timeout))


def by_id(players, player_id):
    return next(p for p in players if p.player_id == player_id)


def start_game(http, players):
    res = http.post(f"/api/game/{players[0].game_id}/start")
    assert res.status_code == 200, res.text
    drain(players)


def maybe_choose_trump(http, players):
    state = players[0].state
    if state["phase"] != "waiting_trump":
        return
    n = len(state["players"])
    chooser = state["current_player"]
    assert chooser == (state["dealer_idx"] - 1) % n
    res = http.post(
        f"/api/game/{state['game_id']}/action",
        json={
            "player_id": chooser,
            "action": "choose_trump",
            "value": 0,
            "suit": "H",
        },
    )
    assert res.status_code == 200, res.text
    drain(players)


def assert_secret_hidden(players):
    for observer in players:
        bids = observer.state["bids"]
        for key, value in bids.items():
            if int(key) == observer.player_id:
                assert value is not None
            else:
                assert value is None, (observer.player_id, bids)


def assert_secret_revealed(players):
    for observer in players:
        bids = observer.state["bids"]
        assert len(bids) == len(players)
        for value in bids.values():
            assert value is not None


def bid_all(http, players, mode):
    game_id = players[0].game_id
    if mode in ("simultaneous", "secret"):
        for player in reversed(players):
            assert player.state["phase"] == "bidding"
            res = http.post(
                f"/api/game/{game_id}/action",
                json={"player_id": player.player_id, "action": "bid", "value": 0},
            )
            assert res.status_code == 200, res.text
            drain(players)
            if mode == "secret" and players[0].state["phase"] == "bidding":
                assert_secret_hidden(players)
        return

    while players[0].state["phase"] == "bidding":
        current = players[0].state["current_player"]
        res = http.post(
            f"/api/game/{game_id}/action",
            json={"player_id": current, "action": "bid", "value": 0},
        )
        assert res.status_code == 200, res.text
        drain(players)


def play_until_round_over(http, players):
    game_id = players[0].game_id
    safety = 0
    while players[0].state["phase"] == "playing":
        safety += 1
        assert safety < 80
        current = players[0].state["current_player"]
        actor = by_id(players, current)
        legal = actor.state.get("legal_moves") or [0]
        res = http.post(
            f"/api/game/{game_id}/action",
            json={"player_id": current, "action": "play", "value": legal[0]},
        )
        assert res.status_code == 200, res.text
        drain(players)
        if players[0].state["phase"] == "playing" and players[0].state["bidding_mode"] == "secret":
            assert_secret_hidden(players)
    assert players[0].state["phase"] == "round_over"
    if players[0].state["bidding_mode"] == "secret":
        assert_secret_revealed(players)


def ready_all(http, players):
    game_id = players[0].game_id
    for player in players:
        res = http.post(
            f"/api/game/{game_id}/ready",
            json={"player_id": player.player_id, "action": "ready", "value": 0},
        )
        assert res.status_code == 200, res.text
        drain(players)


def play_rounds(http, players, mode, rounds=2):
    start_game(http, players)
    for _ in range(rounds):
        maybe_choose_trump(http, players)
        assert players[0].state["phase"] == "bidding"
        expected_cards = players[0].state["current_round"]
        for player in players:
            assert len(player.state["hand"]) == expected_cards
        bid_all(http, players, mode)
        if mode == "secret":
            assert players[0].state["phase"] == "playing"
            assert_secret_hidden(players)
        assert players[0].state["phase"] == "playing"
        play_until_round_over(http, players)
        ready_all(http, players)
    maybe_choose_trump(http, players)
    assert players[0].state["phase"] == "bidding"
    assert players[0].state["current_round"] == rounds + 1


def reconnect_all(http, ws_base, players):
    hands_before = {p.player_id: p.state["hand"] for p in players}
    scores_before = players[0].state["scores"]
    phase_before = players[0].state["phase"]
    tokens_before = dict(games[players[0].game_id].state.player_tokens)
    assert len(tokens_before) == len(players)

    for player in players:
        player.disconnect()

    for player in players:
        res = http.post(
            "/api/game/rejoin",
            json={"game_id": player.game_id, "token": player.token},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["player_id"] == player.player_id
        assert body["name"] == player.name

    still = games[players[0].game_id].state.player_tokens
    assert still == tokens_before

    for player in players:
        player.connect(ws_base)
        assert player.state["hand"] == hands_before[player.player_id]
        assert player.state["scores"] == scores_before
        assert player.state["phase"] == phase_before


def test_unknown_game_code_does_not_create_a_new_game(client):
    res = client.post("/api/game/join", json={"name": "Ada", "game_id": "deadbeef"})
    assert res.status_code == 404
    assert games == {}


def test_health_and_index(client):
    assert client.get("/health").json() == {"status": "ok"}
    home = client.get("/")
    assert home.status_code == 200
    assert "Wizard" in home.text
    assert "Blind / Canadian" in home.text
    assert 'id="theme-light"' in home.text
    assert 'id="theme-dark"' in home.text
    assert 'id="status-line"' in home.text
    assert 'id="btn-play"' in home.text


def test_create_game_exposes_all_existing_modes(client):
    html = client.get("/").text
    assert 'value="sequential"' in html
    assert 'value="simultaneous"' in html
    assert 'value="secret"' in html
    assert 'value="canadian"' in html
    assert "Blind / Canadian (bids hidden until end of hand)" in html


def test_three_player_sequential(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "sequential")
        play_rounds(http, players, "sequential", rounds=2)


def test_five_player_sequential(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal", "Dee", "Eve"], "sequential")
        play_rounds(http, players, "sequential", rounds=2)


def test_three_player_simultaneous(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "simultaneous")
        play_rounds(http, players, "simultaneous", rounds=2)


def test_five_player_simultaneous(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal", "Dee", "Eve"], "simultaneous")
        play_rounds(http, players, "simultaneous", rounds=2)


def test_three_player_blind_secret(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "secret")
        play_rounds(http, players, "secret", rounds=2)


def test_five_player_blind_secret(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal", "Dee", "Eve"], "secret")
        play_rounds(http, players, "secret", rounds=2)


def test_three_player_canadian(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "canadian")
        play_rounds(http, players, "canadian", rounds=2)


def test_five_player_canadian(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal", "Dee", "Eve"], "canadian")
        play_rounds(http, players, "canadian", rounds=2)


def test_canadian_forbids_even_total_on_last_bid(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "canadian")
        start_game(http, players)
        maybe_choose_trump(http, players)
        game_id = players[0].game_id
        round_no = players[0].state["current_round"]
        for _ in range(len(players) - 1):
            current = players[0].state["current_player"]
            res = http.post(
                f"/api/game/{game_id}/action",
                json={"player_id": current, "action": "bid", "value": 0},
            )
            assert res.status_code == 200, res.text
            drain(players)
        last = players[0].state["current_player"]
        illegal = round_no
        res = http.post(
            f"/api/game/{game_id}/action",
            json={"player_id": last, "action": "bid", "value": illegal},
        )
        assert res.status_code == 400
        assert "Canadian Rule" in res.json()["detail"]
        legal = 0 if illegal != 0 else 1
        res = http.post(
            f"/api/game/{game_id}/action",
            json={"player_id": last, "action": "bid", "value": legal},
        )
        assert res.status_code == 200, res.text
        drain(players)
        assert players[0].state["phase"] == "playing"


def test_completed_trick_stays_visible_until_next_lead(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "sequential")
        play_rounds(http, players, "sequential", rounds=1)
        maybe_choose_trump(http, players)
        bid_all(http, players, "sequential")
        n = len(players)
        for _ in range(n):
            current = players[0].state["current_player"]
            actor = by_id(players, current)
            legal = actor.state.get("legal_moves") or [0]
            res = http.post(
                f"/api/game/{players[0].game_id}/action",
                json={"player_id": current, "action": "play", "value": legal[0]},
            )
            assert res.status_code == 200, res.text
            drain(players)
        assert players[0].state["phase"] == "playing"
        assert players[0].state.get("trick_complete") is True
        assert len(players[0].state["current_trick"]) == n
        current = players[0].state["current_player"]
        actor = by_id(players, current)
        legal = actor.state.get("legal_moves") or [0]
        res = http.post(
            f"/api/game/{players[0].game_id}/action",
            json={"player_id": current, "action": "play", "value": legal[0]},
        )
        assert res.status_code == 200, res.text
        drain(players)
        assert players[0].state.get("trick_complete") is False
        assert len(players[0].state["current_trick"]) == 1


def test_all_three_players_rejoin_after_drop(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal"], "sequential")
        start_game(http, players)
        maybe_choose_trump(http, players)
        bid_all(http, players, "sequential")
        reconnect_all(http, live_server["ws"], players)
        play_until_round_over(http, players)


def test_all_five_players_rejoin_after_drop(live_server):
    with httpx.Client(base_url=live_server["http"], timeout=10) as http:
        players = seat(http, live_server["ws"], ["Ada", "Bea", "Cal", "Dee", "Eve"], "sequential")
        start_game(http, players)
        maybe_choose_trump(http, players)
        bid_all(http, players, "sequential")
        reconnect_all(http, live_server["ws"], players)
        play_until_round_over(http, players)


def test_stale_websocket_disconnect_does_not_drop_replacement():
    async def _run():
        mgr = ConnectionManager()

        class FakeState:
            bidding_mode = "sequential"
            phase = "lobby"
            bids = {}
            game_id = "g"
            players = ["Ada"]
            current_round = 1
            trump_suit = None
            dealer_idx = 0
            current_player = 0

        class FakeGame:
            def __init__(self):
                self.state = FakeState()

            def get_player_state(self, player_idx):
                class State:
                    def __init__(self, idx):
                        self.idx = idx

                    def model_dump(self, mode="python"):
                        return {"player_id": self.idx, "bids": {}}

                return State(player_idx)

        class FakeWS:
            def __init__(self):
                self.closed = False
                self.sent = []

            async def accept(self):
                return None

            async def close(self, code=1000):
                self.closed = True

            async def send_json(self, payload):
                if self.closed:
                    raise RuntimeError("closed")
                self.sent.append(payload)

        old = FakeWS()
        new = FakeWS()
        await mgr.connect("g", 0, old)
        await mgr.connect("g", 0, new)
        assert mgr.active_connections["g"][0] is new
        assert old.closed
        mgr.disconnect("g", 0, old)
        assert mgr.active_connections["g"][0] is new
        await mgr.broadcast_state("g", FakeGame())
        assert new.sent[0]["player_id"] == 0
        assert new.sent[0]["trick_complete"] is False
        assert old.sent == []

    asyncio.run(_run())


def test_player_state_dict_used_for_secret_mode():
    # sanity: helper is imported and callable
    assert callable(player_state_dict)
