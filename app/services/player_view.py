"""Redacted player views for the wire protocol.

Leaves app/core/game.py untouched. Blind / Canadian (BiddingMode.SECRET)
hides everyone else's bid until the hand is over (round_over / game_over).
Each player still sees their own bid so the UI knows they have already bid.

Completed tricks are overlaid from trick_hold until the next lead so the
table can show every card that was just played.
"""
from typing import Any, Dict

from app.models.game import BiddingMode, GamePhase
from app.services.trick_hold import dump_trick, get_hold

# Duplicated from the engine for display only — not imported from game.py.
_MAX_ROUNDS = {3: 20, 4: 15, 5: 12, 6: 10}


def _val(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


def infer_flip(game) -> Dict[str, Any]:
    """What the UI should show for the flipped trump card.

    The engine does not persist the flipped card, so this is inferred:
    WAITING_TRUMP only happens on a Wizard; no trump in a non-final round
    is a Jester; no trump on the last round means nothing was flipped.
    """
    phase = _val(game.state.phase)
    trump = game.state.trump_suit
    n = len(getattr(game.state, "players", []) or [])
    last = game.state.current_round >= _MAX_ROUNDS.get(n, 99)
    if phase in (_val(GamePhase.WAITING_TRUMP), "waiting_trump"):
        return {"kind": "wizard", "label": "Wizard flipped"}
    if trump:
        return {"kind": "suit", "suit": trump, "label": f"Trump {trump}"}
    if phase in ("bidding", "playing", "round_over"):
        if last:
            return {"kind": "none", "label": "No trump"}
        return {"kind": "jester", "label": "Jester flipped — no trump"}
    return {"kind": "none", "label": "No trump"}


def player_state_dict(game, player_idx: int) -> Dict[str, Any]:
    data = game.get_player_state(player_idx).model_dump(mode="json")
    mode = _val(game.state.bidding_mode)
    phase = _val(game.state.phase)
    if mode == _val(BiddingMode.SECRET):
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

    live_trick = data.get("current_trick") or []
    held = get_hold(game.state.game_id)
    if held and not live_trick:
        data["current_trick"] = dump_trick(held)
        data["trick_complete"] = True
    else:
        data["trick_complete"] = False
    data["flip"] = infer_flip(game)
    return data
