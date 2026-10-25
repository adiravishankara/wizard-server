"""JSON-file backed store for leagues, rosters and per-game team assignments.

Persists to <repo>/data/wizard_league.json so leagues survive server
restarts. Game sessions themselves stay in-memory (as the game router does).
"""
import json
import threading
from pathlib import Path
from typing import Dict, List, Optional

from app.models.league import League, GameTeam

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STORE_FILE = DATA_DIR / "wizard_league.json"


class LeagueStore:
    def __init__(self, path: Path = STORE_FILE):
        self.path = path
        self._lock = threading.Lock()
        self.leagues: Dict[str, League] = {}
        self.game_teams: Dict[str, List[GameTeam]] = {}  # game_id -> teams
        self._load()

    # ---- persistence ----
    def _load(self):
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text())
            for lid, ldata in raw.get("leagues", {}).items():
                self.leagues[lid] = League(**ldata)
            for gid, tlist in raw.get("game_teams", {}).items():
                self.game_teams[gid] = [GameTeam(**t) for t in tlist]
        except Exception:
            # Corrupt file: start fresh rather than crash the server.
            self.leagues = {}
            self.game_teams = {}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        raw = {
            "leagues": {lid: l.model_dump() for lid, l in self.leagues.items()},
            "game_teams": {
                gid: [t.model_dump() for t in tlist]
                for gid, tlist in self.game_teams.items()
            },
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(raw, indent=2))
        tmp.replace(self.path)

    # ---- leagues ----
    def create_league(self, name: str) -> League:
        with self._lock:
            league = League(name=name)
            self.leagues[league.id] = league
            self._save()
            return league

    def get_league(self, league_id: str) -> Optional[League]:
        return self.leagues.get(league_id)

    def list_leagues(self) -> List[League]:
        return list(self.leagues.values())

    def delete_league(self, league_id: str) -> bool:
        with self._lock:
            if league_id not in self.leagues:
                return False
            del self.leagues[league_id]
            self._save()
            return True

    def mutate_league(self, league_id: str) -> Optional[League]:
        """Return the league for in-place mutation; caller must call save()."""
        return self.leagues.get(league_id)

    def save(self):
        with self._lock:
            self._save()

    # ---- per-game team assignments ----
    def set_game_teams(self, game_id: str, teams: List[GameTeam]):
        with self._lock:
            self.game_teams[game_id] = teams
            self._save()

    def get_game_teams(self, game_id: str) -> List[GameTeam]:
        return self.game_teams.get(game_id, [])


store = LeagueStore()
