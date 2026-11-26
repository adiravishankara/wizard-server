"""Follow-suit / Wizard / Jester legality — engine already enforces; cover 3 & 5 seats."""
import pytest

from app.core.game import WizardGame
from app.models.game import BiddingMode, Card, CardType, GamePhase
from app.services.player_view import infer_flip, player_state_dict

NAMES = ["Ada", "Bea", "Cal", "Dee", "Eve"]


def _card(suit=None, rank=0, typ=CardType.REGULAR):
    return Card(suit=suit, rank=rank, type=typ)


def H(rank): return _card("H", rank)
def D(rank): return _card("D", rank)
def C(rank): return _card("C", rank)
def S(rank): return _card("S", rank)
def W(): return _card(typ=CardType.WIZARD)
def J(): return _card(typ=CardType.JESTER)


def _playing(n, hands, lead_player=0, trump=None, trick=None, lead_suit=None):
    game = WizardGame(f"legal-{n}", BiddingMode.SEQUENTIAL)
    for name in NAMES[:n]:
        game.add_player(name)
    game.state.phase = GamePhase.PLAYING
    game.state.current_round = 2
    game.state.dealer_idx = n - 1
    game.state.trump_suit = trump
    game.state.hands = {i: list(hands[i]) for i in range(n)}
    game.state.bids = {i: 0 for i in range(n)}
    game.state.trick_wins = [0] * n
    game.state.current_trick = list(trick or [])
    game.state.lead_suit = lead_suit
    game.state.current_player = lead_player
    return game


def _idx(hand, pred):
    for i, c in enumerate(hand):
        if pred(c):
            return i
    raise AssertionError("card not in hand")


@pytest.mark.parametrize("n", [3, 5])
def test_must_follow_led_suit_when_holding_it(n):
    hands = {
        0: [H(10), D(9), W()],
        1: [H(7), C(8), S(2)],
        **{i: [D(i + 2), C(i + 2)] for i in range(2, n)},
    }
    game = _playing(n, hands, lead_player=0)
    assert game.play_card(0, _idx(hands[0], lambda c: c.suit == "H"))
    assert game.state.lead_suit == "H"

    pid = 1
    game.state.current_player = pid
    legal = game.get_legal_plays(pid)
    assert all(c.type != CardType.REGULAR or c.suit == "H" for c in legal)
    assert H(7) in legal
    assert C(8) not in legal and S(2) not in legal

    illegal_idx = _idx(game.state.hands[pid], lambda c: c.suit == "C")
    assert game.play_card(pid, illegal_idx) is False
    assert game.play_card(pid, _idx(game.state.hands[pid], lambda c: c.suit == "H"))


@pytest.mark.parametrize("n", [3, 5])
def test_void_in_suit_may_play_anything(n):
    hands = {
        0: [H(12)],
        1: [D(5), C(9), W(), J()],
        **{i: [S(i + 3)] for i in range(2, n)},
    }
    # pad hands so indices stay valid for multi-card rounds
    for i in range(n):
        while len(hands[i]) < 2:
            hands[i].append(S(10 + i))
    game = _playing(n, hands, lead_player=0, trump="S")
    assert game.play_card(0, 0)
    assert game.state.lead_suit == "H"
    game.state.current_player = 1
    legal = game.get_legal_plays(1)
    assert set(id(c) for c in legal) == set(id(c) for c in game.state.hands[1])
    # Club (void) and Wizard both accepted
    assert game.play_card(1, _idx(game.state.hands[1], lambda c: c.suit == "C" and c.type == CardType.REGULAR))


@pytest.mark.parametrize("n", [3, 5])
def test_wizard_and_jester_always_legal_when_following(n):
    hands = {
        0: [H(14)],
        1: [H(3), D(8), W(), J()],
        **{i: [H(4 + i), D(4 + i)] for i in range(2, n)},
    }
    game = _playing(n, hands, lead_player=0)
    assert game.play_card(0, 0)
    game.state.current_player = 1
    legal = game.get_legal_plays(1)
    assert W() in legal and J() in legal and H(3) in legal
    assert D(8) not in legal
    assert game.play_card(1, _idx(game.state.hands[1], lambda c: c.type == CardType.WIZARD))


@pytest.mark.parametrize("n", [3, 5])
def test_jester_lead_next_regular_sets_suit(n):
    hands = {
        0: [J(), H(2)],
        1: [D(10), H(9), W()],
        **{i: [C(i + 2), S(i + 2)] for i in range(2, n)},
    }
    game = _playing(n, hands, lead_player=0)
    assert game.play_card(0, _idx(hands[0], lambda c: c.type == CardType.JESTER))
    assert game.state.lead_suit is None
    # Before a regular is played, anything is legal
    game.state.current_player = 1
    assert len(game.get_legal_plays(1)) == len(game.state.hands[1])
    assert game.play_card(1, _idx(game.state.hands[1], lambda c: c.suit == "D"))
    assert game.state.lead_suit == "D"
    # Next player must follow diamonds if they can
    if n > 2:
        game.state.current_player = 2
        # seat 2 has no diamonds → void, anything ok
        assert len(game.get_legal_plays(2)) == len(game.state.hands[2])


@pytest.mark.parametrize("n", [3, 5])
def test_wizard_lead_anything_may_be_played(n):
    hands = {
        0: [W(), H(2)],
        1: [C(10), D(9), H(8)],
        **{i: [S(i + 2), H(i + 5)] for i in range(2, n)},
    }
    game = _playing(n, hands, lead_player=0)
    assert game.play_card(0, _idx(hands[0], lambda c: c.type == CardType.WIZARD))
    assert game.state.lead_suit is None
    game.state.current_player = 1
    legal = game.get_legal_plays(1)
    assert len(legal) == len(game.state.hands[1])
    assert game.play_card(1, _idx(game.state.hands[1], lambda c: c.suit == "C"))
    # Lead suit stays unset after Wizard lead even after a regular
    assert game.state.lead_suit is None


@pytest.mark.parametrize("n", [3, 5])
def test_api_rejects_illegal_follow_with_clear_error(client, n):
    created = client.post("/api/game/join", json={"name": NAMES[0]}).json()
    gid = created["game_id"]
    for name in NAMES[1:n]:
        client.post("/api/game/join", json={"name": name, "game_id": gid})
    assert client.post(f"/api/game/{gid}/start").status_code == 200

    from app.services.game_store import games
    game = games[gid]
    phase = getattr(game.state.phase, "value", game.state.phase)
    if phase == "waiting_trump":
        assert game.choose_trump(game.state.current_player, "H")
    while getattr(game.state.phase, "value", game.state.phase) == "bidding":
        ok, err = game.submit_bid(game.state.current_player, 0)
        assert ok, err
    assert getattr(game.state.phase, "value", game.state.phase) == "playing"

    # Force a follow-suit situation
    leader = game.state.current_player
    game.state.hands[leader] = [H(14), D(2)]
    followers = [(leader + 1 + k) % n for k in range(n - 1)]
    for k, pid in enumerate(followers):
        game.state.hands[pid] = [H(5 + k), C(8 + k), D(3 + k)]
    assert game.play_card(leader, 0)
    follower = game.state.current_player
    club_idx = _idx(game.state.hands[follower], lambda c: c.suit == "C")
    res = client.post(
        f"/api/game/{gid}/action",
        json={"player_id": follower, "action": "play", "value": club_idx},
    )
    assert res.status_code == 400
    assert "follow suit" in res.json()["detail"].lower()
    # Legal heart still works
    heart_idx = _idx(game.state.hands[follower], lambda c: c.suit == "H")
    ok = client.post(
        f"/api/game/{gid}/action",
        json={"player_id": follower, "action": "play", "value": heart_idx},
    )
    assert ok.status_code == 200, ok.text


@pytest.mark.parametrize("n", [3, 5])
def test_last_round_has_no_trump_flip_or_suit(n):
    game = WizardGame(f"final-{n}", BiddingMode.SEQUENTIAL)
    for name in NAMES[:n]:
        game.add_player(name)
    last = WizardGame.MAX_ROUNDS_MAP[n]
    game.state.dealer_idx = 0
    game.state.current_round = last
    game.deal()
    assert game.state.trump_suit is None
    assert game.state.phase == GamePhase.BIDDING
    flip = infer_flip(game)
    assert flip["kind"] == "none"
    assert flip["suit"] is None
    view = player_state_dict(game, 0)
    assert view["trump_suit"] is None
    assert view["flip"]["kind"] == "none"
    assert view["current_round"] == last
    # All cards dealt: 60 / n == last
    assert last * n == 60
    assert sum(len(h) for h in game.state.hands.values()) == 60


@pytest.mark.parametrize("n", [3, 5])
def test_last_round_trick_winner_ignores_off_suit_as_trump(n):
    """With no trump, only lead suit (or Wizard) wins — off-suit cannot trump."""
    hands = {
        0: [H(10)],
        1: [S(14)],  # spade ace would be trump if trump were S; here it must lose
        **{i: [D(i + 2)] for i in range(2, n)},
    }
    # single-card "round" for the trick
    game = _playing(n, hands, lead_player=0, trump=None)
    game.state.current_round = WizardGame.MAX_ROUNDS_MAP[n]
    for i in range(n):
        game.state.current_player = i
        assert game.play_card(i, 0)
    # After full trick, winner should be lead player (heart 10), not spade ace
    # play_card clears the trick and awards the win
    assert game.state.trick_wins[0] == 1
    assert sum(game.state.trick_wins) == 1


def test_ui_marks_illegal_cards_unplayable():
    css = open("app/static/styles.css").read()
    js = open("app/static/app.js").read()
    assert "pcard.illegal" in css and "pointer-events: none" in css
    assert "legal_moves" in js
    assert "aria-disabled" in js
    assert "Must follow suit" in open("app/routers/game.py").read()
