"""TrackedWizardGame observes the engine without changing outcomes."""
from app.models.game import BiddingMode, CardType, GamePhase
from app.services.player_view import player_state_dict
from app.services.tracked_game import TrackedWizardGame


def _game(n=4):
    game = TrackedWizardGame("tracked", BiddingMode.SEQUENTIAL)
    for name in ["Ada", "Bea", "Cal", "Dee", "Eve"][:n]:
        game.add_player(name)
    return game


def test_flipped_card_matches_trump_state():
    game = _game()
    game.state.dealer_idx = 0
    game.state.current_round = 5
    seen = set()
    for _ in range(300):
        game.deal()
        card = game.flipped_card
        assert card is not None
        if card.type == CardType.WIZARD:
            assert game.state.phase == GamePhase.WAITING_TRUMP
        elif card.type == CardType.JESTER:
            assert game.state.trump_suit is None
        else:
            assert card.suit == game.state.trump_suit
        seen.add(card.type)
        held = [c for hand in game.state.hands.values() for c in hand]
        assert len(held) == 4 * 5
        if len(seen) == 3:
            break
    assert seen == {CardType.REGULAR, CardType.WIZARD, CardType.JESTER}


def test_view_exposes_counts_history_and_ready():
    game = _game(3)
    assert game.start_game()
    if game.state.phase == GamePhase.WAITING_TRUMP:
        assert game.choose_trump(game.state.current_player, "S")
    for _ in range(3):
        ok, err = game.submit_bid(game.state.current_player, 0)
        assert ok, err
    view = player_state_dict(game, 0)
    assert view["hand_counts"] == [1, 1, 1]
    while game.state.phase == GamePhase.PLAYING:
        pid = game.state.current_player
        assert game.play_card(pid, 0)
    assert game.state.phase == GamePhase.ROUND_OVER
    assert len(game.history) == 1
    entry = game.history[0]
    assert entry["round"] == 1 and entry["cards_dealt"] == 1
    assert entry["dealer"] == (game.state.dealer_idx - 1) % 3
    assert entry["trump_source"] in {"flip", "wizard", "jester"}
    if entry["trump_source"] == "wizard":
        assert entry["trump"] == "S" and entry["trump_chosen_by"] == (entry["dealer"] - 1) % 3
    assert entry["scores"] == game.state.scores
    assert sum(entry["tricks"]) == 1
    game.player_ready(1)
    view = player_state_dict(game, 0)
    assert view["ready"] == [1]
    assert view["history"][0]["round"] == 1
