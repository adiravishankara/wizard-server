"""Redacted player views for the wire protocol.

Leaves app/core/game.py untouched. Blind / Canadian (BiddingMode.SECRET)
hides everyone else's bid until the hand is over (round_over / game_over).
Each player still sees their own bid so the UI knows they have already bid.
"""
from typing import Any, Dict

from app.models.game import BiddingMode, GamePhase


def _val(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


def player_state_dict(game, player_idx: int) -> Dict[str, Any]:
    data = game.get_player_state(player_idx).model_dump(mode="json")
    mode = _val(game.state.bidding_mode)
    phase = _val(game.state.phase)
    if mode != _val(BiddingMode.SECRET):
        return data

    hide_others = phase in (
        _val(GamePhase.BIDDING),
        _val(GamePhase.PLAYING),
        "bidding",
        "playing",
    )
    bids: Dict[str, Any] = {}
    for idx, bid in game.state.bids.items():
        key = str(idx)
        if hide_others and int(idx) != player_idx:
            bids[key] = None
        else:
            bids[key] = bid
    data["bids"] = bids
    return data
