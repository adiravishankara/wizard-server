"""Read-only observation layer over the engine.

Records what the table UI needs but the engine does not keep: the card
flipped for trump and a per-round score history. Rules are untouched;
every method defers to WizardGame in app/core/game.py.
"""
from typing import Any, Dict, List, Optional

from app.core.game import WizardGame
from app.models.game import Card, CardType


class TrackedWizardGame(WizardGame):
    def __init__(self, *args, **kwargs):
        self._last_deck: Optional[List[Card]] = None
        self.flipped_card: Optional[Card] = None
        self.history: List[Dict[str, Any]] = []
        super().__init__(*args, **kwargs)

    def build_deck(self) -> List[Card]:
        deck = super().build_deck()
        self._last_deck = deck
        return deck

    def deal(self):
        super().deal()
        self.flipped_card = self._read_flip()

    def _read_flip(self) -> Optional[Card]:
        # deal() shuffles the list from build_deck() in place and slices
        # copies off it, so the original list still holds the full order.
        deck = self._last_deck
        n = len(self.state.players)
        idx = n * self.state.current_round
        if not deck or idx >= len(deck):
            return None
        card = deck[idx]
        phase = getattr(self.state.phase, "value", self.state.phase)
        if card.type == CardType.WIZARD and phase == "waiting_trump":
            return card
        if card.type == CardType.JESTER and self.state.trump_suit is None:
            return card
        if card.type == CardType.REGULAR and card.suit == self.state.trump_suit:
            return card
        return None

    def _trump_info(self) -> Dict[str, Any]:
        n = len(self.state.players)
        flip = self.flipped_card
        if flip is not None and flip.type == CardType.WIZARD:
            source = "wizard"
        elif flip is not None and flip.type == CardType.JESTER:
            source = "jester"
        elif flip is not None:
            source = "flip"
        else:
            source = "none"
        return {
            "trump": self.state.trump_suit,
            "trump_source": source,
            "trump_chosen_by": (self.state.dealer_idx - 1) % n if source == "wizard" and n else None,
        }

    def score_round(self):
        # Runs before the engine advances current_round / dealer_idx, so both
        # still describe the hand that was just played.
        before = list(self.state.scores)
        super().score_round()
        after = list(self.state.scores)
        self.history.append({
            "round": self.state.current_round,
            "cards_dealt": self.state.current_round,
            "dealer": self.state.dealer_idx,
            **self._trump_info(),
            "bids": {str(k): v for k, v in self.state.bids.items()},
            "tricks": list(self.state.trick_wins),
            "deltas": [a - b for a, b in zip(after, before)],
            "scores": after,
        })
