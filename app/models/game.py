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
        
        # Rank mapping
        rank_str = str(self.rank)
        if self.rank == 11: rank_str = "J"
        elif self.rank == 12: rank_str = "Q"
        elif self.rank == 13: rank_str = "K"
        elif self.rank == 14: rank_str = "A"
        
        return f"{self.suit}{rank_str}"
    
    def __str__(self):
        return self.__repr__()

class BiddingMode(str, Enum):
    SEQUENTIAL = "sequential"
    SIMULTANEOUS = "simultaneous"
    SECRET = "secret"
    CANADIAN = "canadian"

class GamePhase(str, Enum):
    LOBBY = "lobby"
    BIDDING = "bidding"
    PLAYING = "playing"
    WAITING_TRUMP = "waiting_trump"
    ROUND_OVER = "round_over"
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
    player_tokens: Dict[str, int] = {} # token (uuid) -> player_idx
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
    bidding_mode: BiddingMode
    hand: List[Card]
    bids: Dict[int, Optional[int]] # Redacted bids if secret
    trump_suit: Optional[str]
    phase: GamePhase
    current_player: int
    current_trick: List[Tuple[int, Card]]
    lead_suit: Optional[str]
    trick_wins: List[int]
    trick_count: Dict[int, int]
    legal_moves: List[int] = [] # Indices of cards in hand that are legal to play
    
    class Config:
        use_enum_values = True
