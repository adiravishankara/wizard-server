import random
from typing import List, Optional, Dict
from app.models.game import Card, CardType, GameState, GamePhase, BiddingMode, PlayerState

class WizardGame:
    SUITS = ["H", "D", "C", "S"]
    MAX_ROUNDS_MAP = {3: 20, 4: 15, 5: 12, 6: 10}

    def __init__(self, game_id: str, bidding_mode: BiddingMode = BiddingMode.SEQUENTIAL):
        self.state = GameState(
            game_id=game_id,
            bidding_mode=bidding_mode,
            phase=GamePhase.LOBBY
        )

    def add_player(self, name: str) -> int:
        if self.state.phase != GamePhase.LOBBY:
            return -1
        if len(self.state.players) >= 6:
            return -1
        self.state.players.append(name)
        self.state.scores.append(0)
        self.state.trick_wins.append(0)
        player_idx = len(self.state.players) - 1
        return player_idx

    def start_game(self):
        num_players = len(self.state.players)
        if num_players < 3:
            return False
        
        self.state.scores = [0] * num_players
        self.state.trick_wins = [0] * num_players
        self.state.current_round = 1
        self.state.dealer_idx = random.randint(0, num_players - 1)
        self.next_round()
        return True

    def next_round(self):
        num_players = len(self.state.players)
        self.state.bids = {}
        self.state.trick_wins = [0] * num_players
        self.state.current_trick = []
        self.state.lead_suit = None
        self.state.current_player = (self.state.dealer_idx + 1) % num_players
        self.deal()

    def build_deck(self) -> List[Card]:
        deck = []
        for suit in self.SUITS:
            for rank in range(1, 14):
                deck.append(Card(suit=suit, rank=rank, type=CardType.REGULAR))
        for _ in range(4):
            deck.append(Card(type=CardType.WIZARD))
            deck.append(Card(type=CardType.JESTER))
        return deck

    def deal(self):
        deck = self.build_deck()
        random.shuffle(deck)
        num_players = len(self.state.players)
        cards_per_player = self.state.current_round
        
        self.state.hands = {}
        for p in range(num_players):
            hand = deck[:cards_per_player]
            # Sort hand: Helpers first then suit then rank
            self.state.hands[p] = sorted(hand, key=lambda c: (c.type != CardType.REGULAR, c.suit or "", c.rank))
            deck = deck[cards_per_player:]
            
        if deck:
            trump_card = deck[0]
            if trump_card.type == CardType.JESTER:
                self.state.trump_suit = None
                self.state.phase = GamePhase.BIDDING
            elif trump_card.type == CardType.WIZARD:
                self.state.phase = GamePhase.WAITING_TRUMP
                # Dealer must pick trump suit
                self.state.current_player = self.state.dealer_idx
            else:
                self.state.trump_suit = trump_card.suit
                self.state.phase = GamePhase.BIDDING
        else:
            self.state.trump_suit = None
            self.state.phase = GamePhase.BIDDING

    def choose_trump(self, player_idx: int, suit: str):
        if self.state.phase != GamePhase.WAITING_TRUMP or player_idx != self.state.dealer_idx:
            return False
        if suit not in self.SUITS:
            return False
        self.state.trump_suit = suit
        self.state.phase = GamePhase.BIDDING
        self.state.current_player = (self.state.dealer_idx + 1) % len(self.state.players)
        return True

    def submit_bid(self, player_idx: int, bid: int):
        if self.state.phase != GamePhase.BIDDING or player_idx != self.state.current_player:
            return False
        
        # Valid bid: 0 to current_round
        if not (0 <= bid <= self.state.current_round):
            return False
            
        self.state.bids[player_idx] = bid
        num_players = len(self.state.players)
        
        if len(self.state.bids) == num_players:
            self.state.phase = GamePhase.PLAYING
            self.state.current_player = (self.state.dealer_idx + 1) % num_players
        else:
            self.state.current_player = (self.state.current_player + 1) % num_players
        return True

    def get_legal_plays(self, player_idx: int) -> List[Card]:
        hand = self.state.hands[player_idx]
        if not self.state.lead_suit:
            return hand
        
        # Must follow suit if possible, unless playing special
        has_lead_suit = any(c.suit == self.state.lead_suit for c in hand if c.type == CardType.REGULAR)
        if not has_lead_suit:
            return hand
            
        legal = []
        for c in hand:
            if c.type != CardType.REGULAR or c.suit == self.state.lead_suit:
                legal.append(c)
        return legal

    def play_card(self, player_idx: int, card_idx: int):
        if self.state.phase != GamePhase.PLAYING or player_idx != self.state.current_player:
            return False
            
        hand = self.state.hands[player_idx]
        if not (0 <= card_idx < len(hand)):
            return False
            
        card = hand[card_idx]
        legal_cards = self.get_legal_plays(player_idx)
        
        if card not in legal_cards:
            return False
            
        self.state.hands[player_idx].pop(card_idx)
        self.state.current_trick.append((player_idx, card))
        
        # Update lead suit if it's the first card and not a special
        if len(self.state.current_trick) == 1:
            if card.type == CardType.REGULAR:
                self.state.lead_suit = card.suit
            elif card.type == CardType.WIZARD:
                # Wizard as lead? It doesn't set a lead suit effectively, or rather it wins immediately?
                # Actually Wizard lead means any suit can be played but no lead suit is set.
                self.state.lead_suit = None
            elif card.type == CardType.JESTER:
                # Jester lead: first regular card determines lead suit
                self.state.lead_suit = None

        # Re-eval lead suit if all previous were jesters and this is a regular
        if self.state.lead_suit is None:
             for _, c in self.state.current_trick:
                 if c.type == CardType.REGULAR:
                     self.state.lead_suit = c.suit
                     break

        num_players = len(self.state.players)
        if len(self.state.current_trick) == num_players:
            winner_idx = self._calculate_trick_winner()
            self.state.trick_wins[winner_idx] += 1
            self.state.current_player = winner_idx
            self.state.current_trick = []
            self.state.lead_suit = None
            
            # Check if round over
            if not self.state.hands[0]:
                self.score_round()
                if self.state.current_round == self.MAX_ROUNDS_MAP[num_players]:
                    self.state.phase = GamePhase.GAME_OVER
                else:
                    self.state.current_round += 1
                    self.state.dealer_idx = (self.state.dealer_idx + 1) % num_players
                    self.next_round()
        else:
            self.state.current_player = (self.state.current_player + 1) % num_players
            
        return True

    def _calculate_trick_winner(self) -> int:
        trick = self.state.current_trick
        # 1. First Wizard wins
        for p_idx, card in trick:
            if card.type == CardType.WIZARD:
                return p_idx
        
        # 2. Highest Trump
        if self.state.trump_suit:
            highest_trump = -1
            winner = -1
            for p_idx, card in trick:
                if card.suit == self.state.trump_suit and card.type == CardType.REGULAR:
                    if card.rank > highest_trump:
                        highest_trump = card.rank
                        winner = p_idx
            if winner != -1:
                return winner
                
        # 3. Highest Lead Suit
        if self.state.lead_suit:
            highest_lead = -1
            winner = -1
            for p_idx, card in trick:
                if card.suit == self.state.lead_suit and card.type == CardType.REGULAR:
                    if card.rank > highest_lead:
                        highest_lead = card.rank
                        winner = p_idx
            if winner != -1:
                return winner
                
        # 4. All Jesters or no lead suit set (e.g. all jesters + one regular that didn't match?)
        # Actually if no lead suit and no trump and no wizard, first player wins? 
        # (Only happens if all jesters)
        return trick[0][0]

    def score_round(self):
        for i in range(len(self.state.players)):
            bid = self.state.bids[i]
            wins = self.state.trick_wins[i]
            if bid == wins:
                self.state.scores[i] += 20 + (wins * 10)
            else:
                self.state.scores[i] -= abs(bid - wins) * 10

    def get_player_state(self, player_idx: int) -> PlayerState:
        # Redact other hands and potentially bids
        visible_bids = {}
        for i, b in self.state.bids.items():
            if self.state.bidding_mode == BiddingMode.SECRET and self.state.phase == GamePhase.BIDDING:
                visible_bids[i] = None
            else:
                visible_bids[i] = b

        return PlayerState(
            game_id=self.state.game_id,
            player_id=player_idx,
            player_name=self.state.players[player_idx],
            players=self.state.players,
            scores=self.state.scores,
            current_round=self.state.current_round,
            dealer_idx=self.state.dealer_idx,
            hand=self.state.hands.get(player_idx, []),
            bids=visible_bids,
            trump_suit=self.state.trump_suit,
            phase=self.state.phase,
            current_player=self.state.current_player,
            current_trick=self.state.current_trick,
            lead_suit=self.state.lead_suit,
            trick_wins=self.state.trick_wins,
            trick_count={i: self.state.trick_wins[i] if i < len(self.state.trick_wins) else 0 for i in range(len(self.state.players))}
        )
