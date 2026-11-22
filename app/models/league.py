"""League, team, roster and recorded-result models.

These models sit *on top of* the game engine. Team scores are derived from
live game state (player scores) plus team assignments, so the core gameplay
files are never touched.
"""
from datetime import datetime, timezone
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, computed_field
import uuid


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short_id() -> str:
    return uuid.uuid4().hex[:12]


class LeaguePlayer(BaseModel):
    id: str = Field(default_factory=_short_id)
    name: str
    joined_at: str = Field(default_factory=_now_iso)


class Team(BaseModel):
    id: str = Field(default_factory=_short_id)
    name: str
    color: str = "#4f8cff"  # hex color used by the UI
    player_ids: List[str] = []  # roster: LeaguePlayer ids


class RecordPlayer(BaseModel):
    """One player's line in a recorded game.

    `league_player_id` is None for guests who are not on the league roster;
    they show in the game detail but not on the leaderboard.
    """
    name: str
    league_player_id: Optional[str] = None
    seat: Optional[int] = None
    score: int = 0
    team_id: Optional[str] = None
    bids_made: Optional[int] = None   # rounds where tricks == bid
    rounds_bid: Optional[int] = None  # rounds with a bid on record


class RecordRound(BaseModel):
    """Per-round breakdown for games recorded from a live table (seat-indexed)."""
    round: int
    bids: Dict[str, int] = {}
    tricks: List[int] = []
    deltas: List[int] = []


class LeagueGameRecord(BaseModel):
    id: str = Field(default_factory=_short_id)
    game_id: Optional[str] = None     # live game code; None for manual entries
    source: str = "live"              # "live" | "manual"
    played_at: str = Field(default_factory=_now_iso)
    edited_at: Optional[str] = None
    rounds_played: int = 0
    bidding_mode: Optional[str] = None
    players: List[RecordPlayer] = []
    rounds: List[RecordRound] = []
    notes: str = ""
    team_scores: Dict[str, int] = {}  # team_id -> final team score
    team_names: Dict[str, str] = {}   # team_id -> name snapshot
    team_colors: Dict[str, str] = {}  # team_id -> color snapshot
    winner_team_ids: List[str] = []   # more than one = tie
    winner_team_id: Optional[str] = None  # sole team winner (None on a tie)

    @computed_field
    @property
    def winner_names(self) -> List[str]:
        if not self.players:
            return []
        top = max(p.score for p in self.players)
        return [p.name for p in self.players if p.score == top]

    @computed_field
    @property
    def player_tie(self) -> bool:
        return len(self.winner_names) > 1

    @computed_field
    @property
    def team_tie(self) -> bool:
        return len(self.winner_team_ids) > 1


class League(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    name: str
    created_at: str = Field(default_factory=_now_iso)
    players: Dict[str, LeaguePlayer] = {}  # id -> player
    teams: Dict[str, Team] = {}            # id -> team
    games: List[LeagueGameRecord] = []


class GameTeam(BaseModel):
    """A team as assigned to a specific game session.

    `league_team_id` links back to a league roster team when the assignment
    came from a league; otherwise the team is game-local (name/color/players
    captured at assignment time).
    """
    id: str = Field(default_factory=_short_id)
    name: str
    color: str = "#4f8cff"
    league_id: Optional[str] = None
    league_team_id: Optional[str] = None
    player_indices: List[int] = []  # player_idx in the game session


class GameLink(BaseModel):
    """How a live game maps onto a league: seat -> league player, plus teams."""
    game_id: str
    league_id: Optional[str] = None
    seat_players: Dict[str, Optional[str]] = {}  # str(seat) -> league player id
    teams: List[GameTeam] = []
    recorded_record_id: Optional[str] = None
    updated_at: str = Field(default_factory=_now_iso)


class TeamScore(BaseModel):
    team_id: str
    name: str
    color: str
    player_indices: List[int]
    player_names: List[str]
    score: int
    tricks_won: int


class StandingRow(BaseModel):
    team_id: str
    name: str
    color: str
    player_ids: List[str] = []
    games_played: int
    wins: int
    ties: int = 0
    total_points: int
    avg_points: float


class PlayerStatRow(BaseModel):
    player_id: str
    name: str
    team_id: Optional[str] = None
    team_name: Optional[str] = None
    team_color: Optional[str] = None
    games_played: int = 0
    wins: int = 0
    ties: int = 0
    total_points: int = 0
    avg_score: float = 0.0
    best_score: Optional[int] = None
    bids_made: int = 0
    rounds_bid: int = 0
    bid_accuracy: Optional[float] = None  # 0..1, None when no bid data
