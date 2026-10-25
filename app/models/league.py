"""League, team and roster models.

These models sit *on top of* the game engine. Team scores are derived from
live game state (player scores) plus team assignments, so the core gameplay
files are never touched.
"""
from datetime import datetime, timezone
from typing import Dict, List, Optional
from pydantic import BaseModel, Field
import uuid


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class LeaguePlayer(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    name: str
    joined_at: str = Field(default_factory=_now_iso)


class Team(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    name: str
    color: str = "#4f8cff"  # hex color used by the UI
    player_ids: List[str] = []  # roster: LeaguePlayer ids


class LeagueGameRecord(BaseModel):
    game_id: str
    played_at: str = Field(default_factory=_now_iso)
    rounds_played: int = 0
    team_scores: Dict[str, int] = {}  # team_id -> final team score
    team_names: Dict[str, str] = {}   # team_id -> name snapshot
    winner_team_id: Optional[str] = None


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
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    name: str
    color: str = "#4f8cff"
    league_id: Optional[str] = None
    league_team_id: Optional[str] = None
    player_indices: List[int] = []  # player_idx in the game session


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
    games_played: int
    wins: int
    total_points: int
    avg_points: float
