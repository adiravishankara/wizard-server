``

from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Any
from enum import Enum
from random import shuffle, choice, randint
import copy

class CardType(Enum):
    REGULAR = 'regular'
    WIZARD = 'wizard'
    JESTER = 'jester'

@dataclass
class Card:
    suit: Optional[str]  # H, D, C, S or None
    rank: int  # 1-13, ignore for specials
    type: CardType

    def is_wizard(self) -> bool:
        return self.type == CardType.WIZARD

    def is_jester(self) -> bool:
        return self.type == CardType.JESTER

    def is_special(self) -> bool:
        return self.is_wizard() or self.is_jester()

    def is_trump(self, trump_suit: Optional[str]) -> bool:
        if self.is_wizard():
            return True
        return trump_suit is not None and self.suit == trump_suit

    def __repr__(self):
        if self.is_wizard():
            return 'W'
        if self.is_jester():
            return 'J'
        return f'{self.suit}{self.rank}'

class BiddingMode(Enum):
    SEQUENTIAL = 'sequential'  # normal, bids visible in order
    SIMULTANEOUS = 'simultaneous'  # home, all submit, reveal together
    SECRET = 'secret'  # canadian, submit hidden till end

class GamePhase(Enum):
    BIDDING = 'bidding'
    PLAYING = 'playing'
    WAITING_TRUMP = 'waiting_trump'

@dataclass
class GameState:
    num_players: int
    players: List[str]  # names
    bidding_mode: BiddingMode
    scores: List[int] = None  # init 0
    current_round: int = 1  # 1-based
    dealer_idx: int = 0
    hands: Dict[int, List[Card]] = None  # player_idx -> hand
    bids: Dict[int, int] = None  # player -> bid
    trump_suit: Optional[str] = None
    phase: GamePhase = GamePhase.BIDDING
    current_player: int = 0
    current_trick: List[tuple[int, Card]] = None  # (player, card)
    lead_suit: Optional[str] = None  # updated during trick
    trick_wins: List[int] = None  # wins this round per player
    max_rounds: Dict[int, int] = None  # {3:20, 4:15, 5:12, 6:10}

    def __post_init__(self):
        if self.scores is None:
            self.scores = [0] * self.num_players
        if self.max_rounds is None:
            self.max_rounds = {3:20, 4:15, 5:12, 6:10}
        if self.hands is None:
            self.hands = {}
        if self.bids is None:
            self.bids = {}
        if self.current_trick is None:
            self.current_trick = []
        if self.trick_wins is None:
            self.trick_wins = [0] * self.num_players

    SUITS = ['H', 'D', 'C', 'S']

    @classmethod
    def create(cls, num_players: int, players: List[str], bidding_mode: BiddingMode):
        game = cls(num_players, players, bidding_mode)
        game.dealer_idx = 0
        game.current_round = 1
        game.current_player = (game.dealer_idx + 1) % num_players  # left of dealer for bidding/lead
        return game

    def get_max_rounds(self) -> int:
        return self.max_rounds[self.num_players]

    def is_game_over(self) -> bool:
        return self.current_round > self.get_max_rounds()

    def next_round(self):
        self.current_round += 1
        self.dealer_idx = (self.dealer_idx + 1) % self.num_players
        self.current_player = (self.dealer_idx + 1) % self.num_players
        self.phase = GamePhase.BIDDING
        self.bids = {}
        self.trick_wins = [0] * self.num_players
        self.deal()

    def deal(self):
        deck = self.build_deck()
        shuffle(deck)
        cards_per_player = self.current_round
        self.hands = {}
        for p in range(self.num_players):
            self.hands[p] = sorted(deck[:cards_per_player], key=lambda c: (c.suit or '', -c.rank if not c.is_special() else 0))
            deck = deck[cards_per_player:]
        # flip trump
        if deck:  # not last round
            trump_card = deck[0]
            if trump_card.is_jester():
                self.trump_suit = None
            elif trump_card.is_wizard():
                self.phase = GamePhase.WAITING_TRUMP
                # dealer chooses later
            else:
                self.trump_suit = trump_card.suit
        else:
            self.trump_suit = None
        self.phase = GamePhase.BIDDING

    @classmethod
    def build_deck(cls) -> List[Card]:
        deck = []
        for suit in cls.SUITS:
            for rank in range(1, 14):
                deck.append(Card(suit, rank, CardType.REGULAR))
        for _ in range(4):
            deck.append(Card(None, 0, CardType.WIZARD))
            deck.append(Card(None, 0, CardType.JESTER))
        return deck

    def submit_bid(self, player: int, bid: int) -> bool:
        if self.phase != GamePhase.BIDDING or player != self.current_player:
            return False
        max_bid = len(self.hands[player])
        if not 0 <= bid <= max_bid:
            return False
        # Canadian check: if dealer leads score, cannot even total bids
        if self.bidding_mode == BiddingMode.SECRET:  # assume canadian
            dealer_score_lead = self.scores[self.dealer_idx] == max(self.scores) and self.scores.count(self.scores[self.dealer_idx]) == 1
            if dealer_score_lead:
                current_total = sum(self.bids.values())
                if current_total + bid == len(self.hands[0]) and bid != 0:
                    return False
        self.bids[player] = bid
        if self.bidding_mode == BiddingMode.SEQUENTIAL:
            self.current_player = (self.current_player + 1) % self.num_players
            if len(self.bids) == self.num_players:
                self.start_playing()
        return True

    def start_simultaneous_bids_reveal(self):
        # called when all submitted
        if len(self.bids) == self.num_players and self.bidding_mode == BiddingMode.SIMULTANEOUS:
            self.start_playing()

    def choose_trump(self, player: int, suit: str):
        if self.phase == GamePhase.WAITING_TRUMP and player == self.dealer_idx and suit in self.SUITS:
            self.trump_suit = suit
            self.phase = GamePhase.BIDDING
            self.current_player = (self.dealer_idx + 1) % self.num_players

    def start_playing(self):
        self.phase = GamePhase.PLAYING
        self.current_trick = []
        self.lead_suit = None
        self.current_player = (self.dealer_idx + 1) % self.num_players  # first lead

    def get_legal_plays(self, player: int) -> List[Card]:
        if self.phase != GamePhase.PLAYING:
            return []
        hand = self.hands[player]
        if not hand:
            return []
        lead_suit = self.lead_suit
        has_lead = any(c.suit == lead_suit for c in hand if not c.is_special())
        legal = []
        for c in hand:
            if lead_suit is None or c.is_special() or c.suit == lead_suit:
                legal.append(c)
        # if has_lead, only lead_suit regulars + specials
        # but since loop: if has_lead, c.suit==lead_suit or special
        # wait, above is exactly: if no lead_suit: all
        # if lead_suit: specials or lead_suit
        # but if has_lead? No need, because even if has_lead, specials allowed, and lead_suit allowed.
        # The filter is always: specials OR lead_suit regulars, regardless of has_lead.
        # If no has_lead, then to play off-suit regular? No!
        # Mistake.
        # Correct:
        # if lead_suit is None: all cards legal
        # else:
        #   legal = specials + lead_suit regulars  # always, because if has, must use one or special; if no has, but wait no:
        # If no has_lead_suit, you can play ANY: other suits + specials + lead (but no)
        # Yes, missed.
        # So:
        legal = []
        if lead_suit is None:
            legal = hand[:]
        else:
            lead_cards = [c for c in hand if c.suit == lead_suit]
            specials = [c for c in hand if c.is_special()]
            if lead_cards:
                legal = lead_cards + specials
            else:
                legal = hand[:]
        return sorted(legal, key=lambda c: (c.is_special(), c.rank))

    def play_card(self, player: int, card: Card) -> bool:
        if self.phase != GamePhase.PLAYING or player != self.current_player:
            return False
        legal = self.get_legal_plays(player)
        if card not in legal:
            return False
        hand = self.hands[player]
        hand.remove(card)
        self.current_trick.append((player, card))
        # update lead_suit
        if self.lead_suit is None and not card.is_special():
            self.lead_suit = card.suit
        self.current_player = (self.current_player + 1) % self.num_players
        if len(self.current_trick) == self.num_players:
            winner_idx = self._get_trick_winner()
            self.trick_wins[winner_idx] += 1
            self.end_trick()
        return True

    def _get_trick_winner(self) -> int:
        trick_cards = [c for _, c in self.current_trick]
        # wizards
        wiz_pos = [i for i, c in enumerate(trick_cards) if c.is_wizard()]
        if wiz_pos:
            return self.current_trick[wiz_pos[0]][0]
        # trumps
        if self.trump_suit:
            trump_high = -1
            trump_pos = -1
            for i, c in enumerate(trick_cards):
                if c.suit == self.trump_suit and c.rank > trump_high:
                    trump_high = c.rank
                    trump_pos = i
            if trump_pos != -1:
                return self.current_trick[trump_pos][0]
        # led suit
        if self.lead_suit is None:
            # all jesters
            return self.current_trick[0][0]
        lead_high = -1
        lead_pos = -1
        for i, c in enumerate(trick_cards):
            if c.suit == self.lead_suit and c.rank > lead_high:
                lead_high = c.rank
                lead_pos = i
        return self.current_trick[lead_pos][0]

    def end_trick(self):
        self.current_trick = []
        self.lead_suit = None
        cards_left = len(self.hands[0])
        if cards_left == 0:
            self.score_round()
            if self.is_game_over():
                return
            self.next_round()
        else:
            self.current_player = self._get_trick_winner()  # wait, last winner leads next
            # but since end_trick after play, winner already set

    def score_round(self):
        for p in range(self.num_players):
            taken = self.trick_wins[p]
            bid = self.bids.get(p, 0)
            if taken == bid:
                self.scores[p] += 20 + 10 * taken
            else:
                self.scores[p] += -10 * abs(taken - bid)

    def to_dict(self) -> Dict[str, Any]:
        # for client: hide others hands, bids if secret
        state = asdict(self)
        state['hands'] = {p: self.hands[p] if p == self.current_player else ['?']*len(self.hands[p]) for p in self.hands}
        if self.bidding_mode == BiddingMode.SECRET and self.phase == GamePhase.PLAYING:
            state['bids'] = {p: '?' for p in self.bids}
        return state

    def get_leader(self) -> int:
        return self.current_player if self.phase == GamePhase.PLAYING and not self.current_trick else (self.dealer_idx + 1) % self.num_players

```