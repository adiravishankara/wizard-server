"""League persistence: an in-memory cache with a pluggable write-through backend.

Backends
--------
* ``FirestoreBackend`` (``app/services/league_firestore.py``) — production.
  Chosen when ``LEAGUE_STORE=firestore``, or when ``LEAGUE_STORE`` is unset and
  any Firebase credential variable is present (see ``CREDENTIAL_ENV_VARS``).
* ``JsonBackend`` — local dev and tests. One JSON file, default
  ``<repo>/data/wizard_league.json`` (override with ``LEAGUE_DATA_FILE``).

Every mutation updates the cache and then writes the touched entity through to
the backend. If the write fails, the cache is reloaded from the backend so it
never claims data the backend does not have, and ``StoreError`` is raised.

Per-game seat links (seat -> league player, teams) only live in memory: they
belong to live games, which are in-memory too and die with the process.
Recorded results carry their own full summary, so nothing recorded depends on
a live game surviving.
"""
import json
import logging
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional, Protocol

from app.models.league import GameLink, GameTeam, League, LeagueGameRecord, LeaguePlayer

log = logging.getLogger("wizard.league_store")

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STORE_FILE = DATA_DIR / "wizard_league.json"

CREDENTIAL_ENV_VARS = (
    "FIREBASE_CREDENTIALS_B64",
    "FIREBASE_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS",
)

_COMPUTED_RECORD_FIELDS = {"winner_names", "player_tie", "team_tie"}


class StoreError(RuntimeError):
    """The backend rejected a write; the cache was resynced from the backend."""


def league_doc(league: League) -> dict:
    return league.model_dump(exclude={"games"})


def record_doc(record: LeagueGameRecord) -> dict:
    return record.model_dump(exclude=_COMPUTED_RECORD_FIELDS)


def _sort_records(records: List[LeagueGameRecord]) -> List[LeagueGameRecord]:
    return sorted(records, key=lambda r: r.played_at)


class LeagueBackend(Protocol):
    name: str

    def load(self) -> Dict[str, League]: ...
    def put_league(self, league: League) -> None: ...
    def delete_league(self, league_id: str) -> None: ...
    def put_record(self, league_id: str, record: LeagueGameRecord) -> None: ...
    def delete_record(self, league_id: str, record_id: str) -> None: ...


class JsonBackend:
    """Whole-file JSON store. Reads the old single-blob format too."""

    name = "json"

    def __init__(self, path: Path = STORE_FILE):
        self.path = Path(path)
        self._leagues: Dict[str, dict] = {}
        self._records: Dict[str, Dict[str, dict]] = {}

    def load(self) -> Dict[str, League]:
        self._leagues, self._records = {}, {}
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text())
        except Exception:
            log.exception("League file %s is unreadable; starting empty", self.path)
            return {}
        migrated = False
        out: Dict[str, League] = {}
        for lid, ldata in (raw.get("leagues") or {}).items():
            games = ldata.get("games") or []
            league = League(**{**ldata, "games": []})
            records = []
            for g in games:
                migrated |= "id" not in g
                records.append(LeagueGameRecord(**g))
            league.games = _sort_records(records)
            out[lid] = league
            self._leagues[lid] = league_doc(league)
            self._records[lid] = {r.id: record_doc(r) for r in league.games}
        if migrated or raw.get("version") != 2:
            self._flush()
        return out

    def _flush(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": 2,
            "leagues": {
                lid: {**doc, "games": sorted(self._records.get(lid, {}).values(),
                                             key=lambda r: r.get("played_at", ""))}
                for lid, doc in self._leagues.items()
            },
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.path)

    def put_league(self, league: League) -> None:
        self._leagues[league.id] = league_doc(league)
        self._records.setdefault(league.id, {})
        self._flush()

    def delete_league(self, league_id: str) -> None:
        self._leagues.pop(league_id, None)
        self._records.pop(league_id, None)
        self._flush()

    def put_record(self, league_id: str, record: LeagueGameRecord) -> None:
        self._records.setdefault(league_id, {})[record.id] = record_doc(record)
        self._flush()

    def delete_record(self, league_id: str, record_id: str) -> None:
        self._records.get(league_id, {}).pop(record_id, None)
        self._flush()


class LeagueStore:
    def __init__(self, backend: LeagueBackend):
        self._lock = threading.RLock()
        self.leagues: Dict[str, League] = {}
        self.links: Dict[str, GameLink] = {}
        self.backend = backend
        self.use_backend(backend)

    @property
    def backend_name(self) -> str:
        return getattr(self.backend, "name", type(self.backend).__name__)

    def use_backend(self, backend: LeagueBackend) -> None:
        with self._lock:
            self.backend = backend
            self.leagues = backend.load()
            self.links = {}

    def _persist(self, write) -> None:
        try:
            write()
        except Exception as exc:
            log.exception("League store write failed (%s backend)", self.backend_name)
            try:
                self.leagues = self.backend.load()
            except Exception:
                log.exception("League store reload after failed write also failed")
            raise StoreError("Could not save league data; please try again.") from exc

    # ---- leagues ----
    def create_league(self, name: str) -> League:
        with self._lock:
            league = League(name=name)
            self.leagues[league.id] = league
            self._persist(lambda: self.backend.put_league(league))
            return league

    def get_league(self, league_id: str) -> Optional[League]:
        return self.leagues.get(league_id)

    def list_leagues(self) -> List[League]:
        return sorted(self.leagues.values(), key=lambda l: l.created_at)

    def delete_league(self, league_id: str) -> bool:
        with self._lock:
            if league_id not in self.leagues:
                return False
            del self.leagues[league_id]
            self._persist(lambda: self.backend.delete_league(league_id))
            for link in self.links.values():
                if link.league_id == league_id:
                    link.league_id = None
            return True

    def save_league(self, league: League) -> None:
        """Persist name / players / teams after an in-place change."""
        with self._lock:
            self._persist(lambda: self.backend.put_league(league))

    # ---- players ----
    @staticmethod
    def find_player_by_name(league: League, name: str) -> Optional[LeaguePlayer]:
        key = name.strip().casefold()
        return next((p for p in league.players.values() if p.name.casefold() == key), None)

    def add_player(self, league: League, name: str) -> LeaguePlayer:
        with self._lock:
            player = LeaguePlayer(name=name.strip())
            league.players[player.id] = player
            self._persist(lambda: self.backend.put_league(league))
            return player

    # ---- recorded games ----
    def get_record(self, league_id: str, record_id: str) -> Optional[LeagueGameRecord]:
        league = self.leagues.get(league_id)
        if not league:
            return None
        return next((r for r in league.games if r.id == record_id), None)

    def add_record(self, league_id: str, record: LeagueGameRecord) -> LeagueGameRecord:
        with self._lock:
            league = self.leagues[league_id]
            league.games = _sort_records(league.games + [record])
            self._persist(lambda: self.backend.put_record(league_id, record))
            return record

    def replace_record(self, league_id: str, record: LeagueGameRecord) -> LeagueGameRecord:
        with self._lock:
            league = self.leagues[league_id]
            league.games = _sort_records([r for r in league.games if r.id != record.id] + [record])
            self._persist(lambda: self.backend.put_record(league_id, record))
            return record

    def delete_record(self, league_id: str, record_id: str) -> bool:
        with self._lock:
            league = self.leagues.get(league_id)
            if not league or not any(r.id == record_id for r in league.games):
                return False
            league.games = [r for r in league.games if r.id != record_id]
            self._persist(lambda: self.backend.delete_record(league_id, record_id))
            for link in self.links.values():
                if link.recorded_record_id == record_id:
                    link.recorded_record_id = None
            return True

    # ---- live-game links (memory only) ----
    def get_link(self, game_id: str) -> Optional[GameLink]:
        return self.links.get(game_id)

    def save_link(self, link: GameLink) -> GameLink:
        with self._lock:
            self.links[link.game_id] = link
            return link

    def get_game_teams(self, game_id: str) -> List[GameTeam]:
        link = self.links.get(game_id)
        return list(link.teams) if link else []

    def set_game_teams(self, game_id: str, teams: List[GameTeam]) -> None:
        with self._lock:
            link = self.links.get(game_id) or GameLink(game_id=game_id)
            link.teams = teams
            self.links[game_id] = link


def backend_from_env(env=None) -> LeagueBackend:
    env = os.environ if env is None else env
    mode = (env.get("LEAGUE_STORE") or "auto").strip().lower()
    has_credentials = any((env.get(k) or "").strip() for k in CREDENTIAL_ENV_VARS)
    if mode not in ("auto", "json", "firestore"):
        raise ValueError(f"LEAGUE_STORE must be auto, json or firestore (got {mode!r})")
    if mode == "firestore" or (mode == "auto" and has_credentials):
        from app.services.league_firestore import FirestoreBackend
        return FirestoreBackend.from_env(env)
    return JsonBackend(Path(env.get("LEAGUE_DATA_FILE") or STORE_FILE))


store = LeagueStore(backend_from_env())
log.info("League store backend: %s", store.backend_name)
