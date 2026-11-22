"""Trump flips: Wizard → player to the right of the dealer chooses; Jester → no trump.

Seat indices increase to the dealer's left (dealer + 1 bids first), so the
player to the right of the dealer is (dealer - 1) % n.
"""
import pytest

from app.core.game import WizardGame
from app.models.game import BiddingMode, GamePhase
from app.services.player_view import player_state_dict

NAMES = ["Ada", "Bea", "Cal", "Dee", "Eve"]


def _seat(n, dealer_idx, round_no=1):
    game = WizardGame("trump-check", BiddingMode.SEQUENTIAL)
    for name in NAMES[:n]:
        game.add_player(name)
    game.state.dealer_idx = dealer_idx
    game.state.current_round = round_no
    return game


def _deal_until(game, pred, tries=600):
    for _ in range(tries):
        game.deal()
        if pred(game):
            return
    pytest.fail("did not deal the required trump flip")


def _wizard_flip(game):
    return game.state.phase == GamePhase.WAITING_TRUMP


@pytest.mark.parametrize("n,dealer", [(3, 0), (3, 1), (3, 2), (5, 0), (5, 2), (5, 4)])
def test_wizard_flip_right_of_dealer_chooses(n, dealer):
    game = _seat(n, dealer)
    _deal_until(game, _wizard_flip)
    right = (dealer - 1) % n
    left = (dealer + 1) % n

    assert game.state.current_player == right
    if dealer == 0:
        assert right == n - 1

    assert game.choose_trump(dealer, "H") is False
    assert game.choose_trump(left, "S") is False
    for other in range(n):
        if other != right:
            assert game.choose_trump(other, "D") is False
    assert game.state.phase == GamePhase.WAITING_TRUMP

    assert game.choose_trump(right, "C") is True
    assert game.state.trump_suit == "C"
    assert game.state.phase == GamePhase.BIDDING
    assert game.state.current_player == left


@pytest.mark.parametrize("n", [3, 5])
def test_bidding_after_trump_choice_starts_left_of_dealer(n):
    game = _seat(n, 0)
    _deal_until(game, _wizard_flip)
    assert game.choose_trump(n - 1, "H")
    first = game.state.current_player
    assert first == 1
    ok, err = game.submit_bid(n - 1, 0)
    assert not ok
    ok, err = game.submit_bid(first, 0)
    assert ok, err
    assert game.state.current_player == 2


@pytest.mark.parametrize("n", [3, 5])
def test_wire_state_names_right_of_dealer_as_chooser(n):
    game = _seat(n, 0)
    _deal_until(game, _wizard_flip)
    for viewer in range(n):
        view = player_state_dict(game, viewer)
        assert view["phase"] == "waiting_trump"
        assert view["current_player"] == n - 1
        assert view["dealer_idx"] == 0
        assert view["flip"]["kind"] == "wizard"


def test_wire_state_hides_stale_trump_while_choosing():
    game = _seat(5, 2)
    _deal_until(game, _wizard_flip)
    game.state.trump_suit = "D"
    view = player_state_dict(game, 0)
    assert view["trump_suit"] is None
    assert view["flip"]["suit"] is None


def test_invalid_suit_rejected_for_chooser():
    game = _seat(3, 0)
    _deal_until(game, _wizard_flip)
    assert game.choose_trump(2, "X") is False
    assert game.state.phase == GamePhase.WAITING_TRUMP


def test_jester_flip_means_no_trump():
    game = _seat(3, 1)
    _deal_until(
        game,
        lambda g: g.state.phase == GamePhase.BIDDING and g.state.trump_suit is None,
    )
    assert game.state.trump_suit is None
    assert game.state.phase == GamePhase.BIDDING
