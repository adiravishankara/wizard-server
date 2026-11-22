"""Blind / Canadian (SECRET) bid hiding without touching app/core/game.py."""
from app.core.game import WizardGame
from app.models.game import BiddingMode, GamePhase
from app.services.player_view import player_state_dict


def _three_player_secret():
    game = WizardGame("blind1", BiddingMode.SECRET)
    for name in ("Ada", "Bea", "Cal"):
        game.add_player(name)
    assert game.start_game()
    if game.state.phase == GamePhase.WAITING_TRUMP:
        game.choose_trump(game.state.dealer_idx, "H")
    assert game.state.phase == GamePhase.BIDDING
    return game


def _bid_remaining(game, value=0):
    for idx in range(len(game.state.players)):
        if idx not in game.state.bids:
            ok, err = game.submit_bid(idx, value)
            assert ok, err


def test_secret_shows_own_bid_hides_others_during_bidding():
    game = _three_player_secret()
    ok, err = game.submit_bid(0, 0)
    assert ok, err
    view0 = player_state_dict(game, 0)
    view1 = player_state_dict(game, 1)
    assert view0["bids"]["0"] == 0
    assert view1["bids"]["0"] is None


def test_secret_hides_others_during_play_reveals_at_round_over():
    game = _three_player_secret()
    _bid_remaining(game, 0)
    assert game.state.phase == GamePhase.PLAYING
    for viewer in range(3):
        view = player_state_dict(game, viewer)
        for idx in range(3):
            if idx == viewer:
                assert view["bids"][str(idx)] == 0
            else:
                assert view["bids"][str(idx)] is None

    # Play the single-card first round.
    while game.state.phase == GamePhase.PLAYING:
        pid = game.state.current_player
        assert game.play_card(pid, 0)

    assert game.state.phase == GamePhase.ROUND_OVER
    for viewer in range(3):
        view = player_state_dict(game, viewer)
        assert view["bids"] == {"0": 0, "1": 0, "2": 0}


def test_five_player_secret_hides_until_hand_end():
    game = WizardGame("blind5", BiddingMode.SECRET)
    for name in ("Ada", "Bea", "Cal", "Dee", "Eve"):
        game.add_player(name)
    assert game.start_game()
    if game.state.phase == GamePhase.WAITING_TRUMP:
        game.choose_trump(game.state.dealer_idx, "H")
    _bid_remaining(game, 0)
    assert game.state.phase == GamePhase.PLAYING
    view = player_state_dict(game, 2)
    assert view["bids"]["2"] == 0
    for idx in (0, 1, 3, 4):
        assert view["bids"][str(idx)] is None
    while game.state.phase == GamePhase.PLAYING:
        pid = game.state.current_player
        legal = game.get_legal_plays(pid)
        hand = game.state.hands[pid]
        card_idx = next(i for i, c in enumerate(hand) if c in legal)
        assert game.play_card(pid, card_idx)
    assert game.state.phase == GamePhase.ROUND_OVER
    view = player_state_dict(game, 4)
    assert all(view["bids"][str(i)] == 0 for i in range(5))
