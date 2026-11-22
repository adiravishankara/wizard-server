"""Lobby extras layered over the engine: host, seat shuffle, rematch.

Seat order before a game starts is just the order of GameState.players
(scores and trick counts are still zero), so shuffling permutes that list
and remaps the session tokens. app/core/game.py is not involved.
"""
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional

LOBBY_PHASE = "lobby"


@dataclass
class LobbyMeta:
    host_token: Optional[str] = None
    shuffle_on_start: bool = False
    shuffled: bool = False                    # seats were shuffled at least once
    rematch_of: Optional[str] = None          # previous game id (on a rematch)
    expected: List[str] = field(default_factory=list)  # previous game's players (on a rematch)
    rematch_id: Optional[str] = None          # next game id (on a finished game)
    rematch_tokens: Dict[str, str] = field(default_factory=dict)  # old token -> token in rematch


_meta: Dict[str, LobbyMeta] = {}


def get_meta(game_id: str) -> LobbyMeta:
    return _meta.setdefault(game_id, LobbyMeta())


def peek_meta(game_id: str) -> Optional[LobbyMeta]:
    return _meta.get(game_id)


def clear_all() -> None:
    _meta.clear()


def phase_of(game) -> str:
    phase = game.state.phase
    return getattr(phase, "value", phase)


def host_seat(game) -> Optional[int]:
    meta = peek_meta(game.state.game_id)
    if not meta or not meta.host_token:
        return None
    return game.state.player_tokens.get(meta.host_token)


def is_host(game, token: Optional[str]) -> bool:
    meta = peek_meta(game.state.game_id)
    if not meta or not meta.host_token:
        return token in game.state.player_tokens
    return token == meta.host_token


def shuffle_seats(game, rng: Optional[random.Random] = None) -> Dict[int, int]:
    """Randomise lobby seat order in place. Returns {old_seat: new_seat}."""
    if phase_of(game) != LOBBY_PHASE:
        raise ValueError("Seats can only be shuffled before the game starts")
    rng = rng or random.Random()
    st = game.state
    n = len(st.players)
    order = list(range(n))
    if n > 1:
        for _ in range(8):
            rng.shuffle(order)
            if order != list(range(n)):
                break
    old_to_new = {old: new for new, old in enumerate(order)}
    st.players = [st.players[old] for old in order]
    st.player_tokens = {tok: old_to_new[seat] for tok, seat in st.player_tokens.items()}
    st.scores = [0] * n
    st.trick_wins = [0] * n
    get_meta(st.game_id).shuffled = True
    return old_to_new


def lobby_view(game, player_idx: int, games: Dict[str, object]) -> Dict[str, object]:
    """Extra wire fields: host seat, shuffle settings, rematch progress."""
    gid = game.state.game_id
    meta = peek_meta(gid)
    out: Dict[str, object] = {
        "host": host_seat(game),
        "shuffle_on_start": bool(meta and meta.shuffle_on_start),
        "seats_shuffled": bool(meta and meta.shuffled),
        "rematch_of": meta.rematch_of if meta else None,
        "waiting_for": [],
        "rematch": None,
    }
    if meta and meta.rematch_of and phase_of(game) == LOBBY_PHASE:
        here = list(game.state.players)
        missing = []
        for name in meta.expected:
            if name in here:
                here.remove(name)
            else:
                missing.append(name)
        out["waiting_for"] = missing
    if meta and meta.rematch_id:
        nxt = games.get(meta.rematch_id)
        tokens = game.state.player_tokens
        joined = sorted(tokens[t] for t in meta.rematch_tokens if t in tokens)
        out["rematch"] = {
            "game_id": meta.rematch_id,
            "joined": joined,
            "started": bool(nxt) and phase_of(nxt) != LOBBY_PHASE,
            "open": bool(nxt) and phase_of(nxt) == LOBBY_PHASE and len(nxt.state.players) < 6,
        }
    return out
