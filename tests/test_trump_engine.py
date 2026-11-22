"""Document what the engine does for Wizard/Jester trump flips.

Does not modify app/core/game.py. The dealer chooses on a Wizard flip;
a Jester means no trump. Adithya's house rule (player to the right of
the dealer) is not what the engine implements.
"""
from app.core.game import WizardGame
from app.models.game import BiddingMode, CardType, GamePhase


def _seat():
    game = WizardGame("trump-check", BiddingMode.SEQUENTIAL)
    for name in ("Ada", "Bea", "Cal"):
        game.add_player(name)
    game.state.dealer_idx = 1
    game.state.current_round = 1
    return game


def test_wizard_flip_chooser_is_dealer_not_right_of_dealer():
    game = _seat()
    found = False
    for _ in range(400):
        game.deal()
        if game.state.phase == GamePhase.WAITING_TRUMP:
            found = True
            break
    assert found, "did not deal a Wizard as the trump flip"
    assert game.state.current_player == game.state.dealer_idx
    right = (game.state.dealer_idx - 1) % 3
    left = (game.state.dealer_idx + 1) % 3
    assert game.choose_trump(right, "H") is False
    assert game.choose_trump(left, "S") is False
    assert game.choose_trump(game.state.dealer_idx, "C") is True
    assert game.state.trump_suit == "C"
    assert game.state.phase == GamePhase.BIDDING


def test_jester_flip_means_no_trump():
    game = _seat()
    found = False
    for _ in range(400):
        game.deal()
        if game.state.phase == GamePhase.BIDDING and game.state.trump_suit is None:
            found = True
            break
    assert found
    assert game.state.phase == GamePhase.BIDDING
    assert game.state.trump_suit is None
