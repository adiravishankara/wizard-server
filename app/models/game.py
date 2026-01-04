from enum import Enum
from typing import List, Optional, Dict, Any, Tuple
from pydantic import BaseModel, Field

class CardType(str, Enum):
    REGULAR = "regular"
    WIZARD = "wizard"
    JESTER = "jester"

class Card(BaseModel):
    suit: Optional[str] = None # H, D, C, S or None
    rank: int = 0 # 1-13, ignore for specials
    type: CardType

    def __repr__(self):
        if self.type == CardType.WIZARD:
            return "W"
        if self.type == CardType.JESTER:
            return "J"
        return f"{self.suit}{self.rank}"
    
    def __str__(self):
        return self.__repr__()

class BiddingMode(str, Enum):
    SEQUENTIAL = "sequential"
    SIMULTANEOUS = "simultaneous"
    SECRET = "secret"

class GamePhase(str, Enum):
    LOBBY = "lobby"
    BIDDING = "bidding"
    PLAYING = "playing"
    WAITING_TRUMP = "waiting_trump"
    GAME_OVER = "game_over"

class GameState(BaseModel):
    game_id: str
    players: List[str] = [] # names
    bidding_mode: BiddingMode = BiddingMode.SEQUENTIAL
    scores: List[int] = []
    current_round: int = 1
    dealer_idx: int = 0
    hands: Dict[int, List[Card]] = {} # player_idx -> hand
    bids: Dict[int, int] = {} # player_idx -> bid
    trump_suit: Optional[str] = None
    phase: GamePhase = GamePhase.LOBBY
    current_player: int = 0
    current_trick: List[Tuple[int, Card]] = [] # (player, card)
    lead_suit: Optional[str] = None
    trick_wins: List[int] = []
    
    class Config:
        use_enum_values = True

class PlayerState(BaseModel):
    """Redacted state for a specific player."""
    game_id: str
    player_id: int
    player_name: str
    players: List[str]
    scores: List[int]
    current_round: int
    dealer_idx: int
    hand: List[Card]
    bids: Dict[int, Optional[int]] # Redacted bids if secret
    trump_suit: Optional[str]
    phase: GamePhase
    current_player: int
    current_trick: List[Tuple[int, Card]]
    lead_suit: Optional[str]
    trick_wins: List[int]
    trick_count: Dict[int, int]
