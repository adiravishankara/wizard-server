"""Redacted player views for the wire protocol.

Leaves app/core/game.py untouched. Blind / Canadian (BiddingMode.SECRET)
hides everyone else's bid until the hand is over (round_over / game_over).
Each player still sees their own bid so the UI knows they have already bid.

Completed tricks are overlaid from trick_hold until the next lead so the
table can show every card that was just played.
"""
from typing import Any, Dict, Optional

from app.models.game import BiddingMode, GamePhase
from app.services.trick_hold import dump_trick, get_hold

# Duplicated from the engine for display only — not imported from game.py.
_MAX_ROUNDS = {3: 20, 4: 15, 5: 12, 6: 10}


def _val(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


def _card_json(card) -> Optional[Dict[str, Any]]:
    if card is None:
        return None
    return card.model_dump(mode="json") if hasattr(card, "model_dump") else card


def infer_flip(game) -> Dict[str, Any]:
    """What the UI should show for the flipped trump card.

    TrackedWizardGame records the real card. Plain WizardGame instances
    fall back to inference: WAITING_TRUMP only happens on a Wizard; no
    trump in a non-final round is a Jester; no trump on the last round
    means nothing was flipped.
    """
    phase = _val(game.state.phase)
    # The engine leaves last round's suit in place until the Wizard chooser picks.
    trump = None if phase == _val(GamePhase.WAITING_TRUMP) else game.state.trump_suit
    card = _card_json(getattr(game, "flipped_card", None))
    if phase in ("lobby", "game_over"):
        return {"kind": "none", "card": None}
    if card is not None:
        kind = {"wizard": "wizard", "jester": "jester"}.get(card.get("type"), "suit")
        return {"kind": kind, "card": card, "suit": trump}
    n = len(getattr(game.state, "players", []) or [])
    last = game.state.current_round >= _MAX_ROUNDS.get(n, 99)
    if phase == _val(GamePhase.WAITING_TRUMP):
        return {"kind": "wizard", "card": {"type": "wizard"}, "suit": None}
    if trump:
        return {"kind": "suit", "card": None, "suit": trump}
    if phase in ("bidding", "playing", "round_over") and not last:
        return {"kind": "jester", "card": {"type": "jester"}, "suit": None}
    return {"kind": "none", "card": None, "suit": None}


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
    if phase == _val(GamePhase.WAITING_TRUMP):
        data["trump_suit"] = None
    data["flip"] = infer_flip(game)
    hands = getattr(game.state, "hands", None) or {}
    players = getattr(game.state, "players", None) or []
    data["hand_counts"] = [len(hands.get(i, []) or []) for i in range(len(players))]
    data["history"] = list(getattr(game, "history", []) or [])
    ready = getattr(game, "players_ready_for_next_round", None) or set()
    data["ready"] = sorted(int(i) for i in ready)
    return data
