"""Keep a completed trick visible until the next lead.

The engine clears current_trick as soon as the last card is played.
This overlay is applied in player_view only — app/core/game.py is unchanged.
"""
from typing import Any, Dict, List, Optional, Tuple

from app.models.game import Card

HeldTrick = List[Tuple[int, Any]]

_held: Dict[str, HeldTrick] = {}


def set_hold(game_id: str, trick: HeldTrick) -> None:
    _held[game_id] = trick


def clear_hold(game_id: str) -> None:
    _held.pop(game_id, None)


def get_hold(game_id: str) -> Optional[HeldTrick]:
    return _held.get(game_id)


def clear_all() -> None:
    _held.clear()


def dump_trick(trick: List[Tuple[int, Card]]) -> List[List[Any]]:
    out: List[List[Any]] = []
    for player_idx, card in trick:
        card_data = card.model_dump(mode="json") if hasattr(card, "model_dump") else card
        out.append([player_idx, card_data])
    return out
