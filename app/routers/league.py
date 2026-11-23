"""League, team, roster, result and stats API.

Read-only with respect to the game engine: team scores and recorded results
are derived from the live game state owned by app.routers.game, which this
module never mutates. Handlers are sync so FastAPI runs them in its thread
pool and Firestore round-trips never block the WebSocket event loop.
"""
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.game import BiddingMode
from app.models.league import (
    GameLink,
    GameTeam,
    League,
    LeagueGameRecord,
    LeaguePlayer,
    PlayerStatRow,
    RecordPlayer,
    RecordRound,
    RoundLine,
    StandingRow,
    Team,
    TeamScore,
)
from app.services.game_store import games
from app.services.league_stats import (
    finalize_record,
    player_leaderboard,
    record_from_game,
    suggest_seats,
    team_of_player,
    team_standings,
    teams_for_seats,
)
from app.services.league_store import store

router = APIRouter()

_MODES = {m.value for m in BiddingMode}


# ---------- request bodies ----------
class NameRequest(BaseModel):
    name: str


class CreateTeamRequest(BaseModel):
    name: str
    color: Optional[str] = None


class UpdateTeamRequest(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class SetRosterRequest(BaseModel):
    player_ids: List[str]


class AddRosterRequest(BaseModel):
    player_id: str


class TeamAssignmentIn(BaseModel):
    id: Optional[str] = None          # league team id when linking a league team
    name: str
    color: Optional[str] = None
    player_indices: List[int] = []


class AssignTeamsRequest(BaseModel):
    league_id: Optional[str] = None
    teams: List[TeamAssignmentIn] = []


class LinkRequest(BaseModel):
    league_id: Optional[str] = None
    seats: Dict[str, Optional[str]] = {}  # str(seat) -> league player id (None = guest)


class RecordGameRequest(BaseModel):
    game_id: str


class ResultPlayerIn(BaseModel):
    league_player_id: Optional[str] = None
    name: Optional[str] = None  # used when no id: matched by name, else added to the league
    score: Optional[int] = None  # required unless per-round scores are given
    bids_made: Optional[int] = None


class RoundLineIn(BaseModel):
    points: int
    bid: Optional[int] = None
    tricks: Optional[int] = None


class RoundIn(BaseModel):
    cards_dealt: Optional[int] = None  # defaults to the hand number
    dealer: Optional[int] = None       # index into ResultIn.players
    trump: Optional[str] = None        # "H" | "D" | "C" | "S"; empty = no trump
    lines: List[RoundLineIn]           # one per player, in ResultIn.players order


class ResultIn(BaseModel):
    played_at: Optional[str] = None  # YYYY-MM-DD or full ISO timestamp
    bidding_mode: Optional[str] = None
    rounds_played: int = 0
    players: List[ResultPlayerIn]
    rounds: Optional[List[RoundIn]] = None  # per-hand scores; None/empty = final only
    notes: str = ""


class SeatOut(BaseModel):
    seat: int
    name: str
    league_player_id: Optional[str] = None


class LinkOut(BaseModel):
    game_id: str
    league_id: Optional[str] = None
    seats: List[SeatOut] = []
    teams: List[GameTeam] = []
    recorded_record_id: Optional[str] = None


# ---------- helpers ----------
def _get_league_or_404(league_id: str) -> League:
    league = store.get_league(league_id)
    if not league:
        raise HTTPException(status_code=404, detail="League not found")
    return league


def _live_game_or_404(game_id: str):
    game = games.get(game_id)
    if not game:
        raise HTTPException(
            status_code=404,
            detail="Game not found (games are in-memory; it may have ended or the server restarted)",
        )
    return game


def _clean_name(raw: str, what: str) -> str:
    name = (raw or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail=f"{what} name is required")
    return name[:48]


def compute_team_scores(game, teams: List[GameTeam]) -> List[TeamScore]:
    state = game.state
    out: List[TeamScore] = []
    for t in teams:
        idxs = [i for i in t.player_indices if 0 <= i < len(state.players)]
        out.append(
            TeamScore(
                team_id=t.id,
                name=t.name,
                color=t.color,
                player_indices=idxs,
                player_names=[state.players[i] for i in idxs],
                score=sum(state.scores[i] for i in idxs),
                tricks_won=sum(
                    state.trick_wins[i] for i in idxs if i < len(state.trick_wins)
                ),
            )
        )
    out.sort(key=lambda s: s.score, reverse=True)
    return out


def _link_out(game, link: Optional[GameLink]) -> LinkOut:
    seats = link.seat_players if link else {}
    return LinkOut(
        game_id=game.state.game_id,
        league_id=link.league_id if link else None,
        seats=[
            SeatOut(seat=i, name=name, league_player_id=seats.get(str(i)))
            for i, name in enumerate(game.state.players)
        ],
        teams=link.teams if link else [],
        recorded_record_id=link.recorded_record_id if link else None,
    )


def _parse_played_at(raw: Optional[str]) -> str:
    if not raw:
        return datetime.now(timezone.utc).isoformat()
    try:
        if len(raw) == 10:
            dt = datetime.strptime(raw, "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must look like 2026-11-22")
    return dt.isoformat()


def _bad(detail: str):
    raise HTTPException(status_code=400, detail=detail)


def _check_rounds(req: ResultIn, labels: List[str]) -> List[List[int]]:
    """Validate per-hand input and return running totals per hand."""
    n = len(labels)
    if len(req.rounds) > 20:
        _bad("A Wizard game has at most 20 hands")
    totals = [0] * n
    running: List[List[int]] = []
    for i, rnd in enumerate(req.rounds, start=1):
        cards = rnd.cards_dealt if rnd.cards_dealt is not None else i
        if not 1 <= cards <= 20:
            _bad(f"Hand {i}: cards dealt must be between 1 and 20")
        if len(rnd.lines) != n:
            _bad(f"Hand {i}: enter points for all {n} players")
        if rnd.dealer is not None and not 0 <= rnd.dealer < n:
            _bad(f"Hand {i}: unknown dealer")
        if rnd.trump and rnd.trump not in ("H", "D", "C", "S"):
            _bad(f"Hand {i}: trump must be H, D, C or S")
        for label, ln in zip(labels, rnd.lines):
            for what, val in (("bid", ln.bid), ("tricks", ln.tricks)):
                if val is not None and not 0 <= val <= cards:
                    _bad(f"Hand {i}: {label}'s {what} must be between 0 and {cards}")
        totals = [t + ln.points for t, ln in zip(totals, rnd.lines)]
        running.append(list(totals))
    return running


def _result_players(league: League, req: ResultIn) -> Tuple[List[RecordPlayer], List[RecordRound]]:
    if not 3 <= len(req.players) <= 6:
        _bad("A Wizard game has 3 to 6 players")
    if req.bidding_mode and req.bidding_mode not in _MODES:
        _bad(f"Unknown bidding mode: {req.bidding_mode}")
    per_round = bool(req.rounds)
    rounds_played = len(req.rounds) if per_round else req.rounds_played
    if not 0 <= rounds_played <= 20:
        _bad("Rounds must be between 0 and 20")
    # Validate everything before adding any new names to the league.
    resolved = []
    seen = set()
    for entry in req.players:
        if entry.league_player_id:
            player = league.players.get(entry.league_player_id)
            if not player:
                _bad("Unknown league player")
            key, label = player.id, player.name
        else:
            label = _clean_name(entry.name or "", "Player")
            player = store.find_player_by_name(league, label)
            key = player.id if player else label.casefold()
        if key in seen:
            _bad(f"{label} is listed twice")
        seen.add(key)
        if entry.score is None and not per_round:
            _bad(f"Enter a final score for {label}")
        if entry.bids_made is not None:
            if not rounds_played:
                _bad("Enter the number of rounds to record bids made")
            if not 0 <= entry.bids_made <= rounds_played:
                _bad(f"{label}: bids made must be between 0 and {rounds_played}")
        resolved.append((entry, player, label))

    labels = [label for _, _, label in resolved]
    running = _check_rounds(req, labels) if per_round else []
    if per_round:
        for idx, (entry, _, label) in enumerate(resolved):
            total = running[-1][idx]
            if entry.score is not None and entry.score != total:
                _bad(f"{label}'s final score {entry.score} doesn't match the hand-by-hand total {total}")

    membership = team_of_player(league)
    out: List[RecordPlayer] = []
    for idx, (entry, player, label) in enumerate(resolved):
        if player is None:
            player = store.add_player(league, label)
        team = membership.get(player.id)
        bids_made, rounds_bid = entry.bids_made, (rounds_played if entry.bids_made is not None else None)
        if per_round:
            pairs = [(r.lines[idx].bid, r.lines[idx].tricks) for r in req.rounds]
            known = [(b, t) for b, t in pairs if b is not None and t is not None]
            if known:
                bids_made, rounds_bid = sum(1 for b, t in known if b == t), len(known)
        out.append(RecordPlayer(
            name=player.name,
            league_player_id=player.id,
            seat=idx if per_round else None,
            score=running[-1][idx] if per_round else entry.score,
            team_id=team.id if team else None,
            bids_made=bids_made,
            rounds_bid=rounds_bid,
        ))

    rounds: List[RecordRound] = []
    for i, rnd in enumerate(req.rounds or [], start=1):
        rounds.append(RecordRound(
            round=i,
            cards_dealt=rnd.cards_dealt if rnd.cards_dealt is not None else i,
            dealer_seat=rnd.dealer,
            dealer=out[rnd.dealer].name if rnd.dealer is not None else None,
            trump=rnd.trump or None,
            trump_source=None,
            players=[
                RoundLine(seat=idx, name=out[idx].name, bid=ln.bid, tricks=ln.tricks,
                          points=ln.points, total=running[i - 1][idx])
                for idx, ln in enumerate(rnd.lines)
            ],
        ))
    return out, rounds


# ---------- leagues ----------
@router.post("/leagues", response_model=League)
def create_league(req: NameRequest):
    return store.create_league(_clean_name(req.name, "League"))


@router.get("/leagues", response_model=List[League])
def list_leagues():
    return store.list_leagues()


@router.get("/leagues/{league_id}", response_model=League)
def get_league(league_id: str):
    return _get_league_or_404(league_id)


@router.put("/leagues/{league_id}", response_model=League)
def rename_league(league_id: str, req: NameRequest):
    league = _get_league_or_404(league_id)
    league.name = _clean_name(req.name, "League")
    store.save_league(league)
    return league


@router.delete("/leagues/{league_id}")
def delete_league(league_id: str):
    if not store.delete_league(league_id):
        raise HTTPException(status_code=404, detail="League not found")
    return {"status": "deleted"}


# ---------- league players ----------
@router.post("/leagues/{league_id}/players", response_model=LeaguePlayer)
def add_league_player(league_id: str, req: NameRequest):
    league = _get_league_or_404(league_id)
    name = _clean_name(req.name, "Player")
    if store.find_player_by_name(league, name):
        raise HTTPException(status_code=409, detail=f"{name} is already in this league")
    return store.add_player(league, name)


@router.put("/leagues/{league_id}/players/{player_id}", response_model=LeaguePlayer)
def rename_league_player(league_id: str, player_id: str, req: NameRequest):
    league = _get_league_or_404(league_id)
    player = league.players.get(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    name = _clean_name(req.name, "Player")
    clash = store.find_player_by_name(league, name)
    if clash and clash.id != player_id:
        raise HTTPException(status_code=409, detail=f"{name} is already in this league")
    player.name = name
    store.save_league(league)
    return player


@router.delete("/leagues/{league_id}/players/{player_id}")
def remove_league_player(league_id: str, player_id: str):
    league = _get_league_or_404(league_id)
    if player_id not in league.players:
        raise HTTPException(status_code=404, detail="Player not found")
    del league.players[player_id]
    for team in league.teams.values():
        if player_id in team.player_ids:
            team.player_ids.remove(player_id)
    store.save_league(league)
    return {"status": "removed"}


# ---------- league teams ----------
@router.post("/leagues/{league_id}/teams", response_model=Team)
def create_team(league_id: str, req: CreateTeamRequest):
    league = _get_league_or_404(league_id)
    team = Team(name=_clean_name(req.name, "Team"), color=req.color or "#4f8cff")
    league.teams[team.id] = team
    store.save_league(league)
    return team


@router.put("/leagues/{league_id}/teams/{team_id}", response_model=Team)
def update_team(league_id: str, team_id: str, req: UpdateTeamRequest):
    league = _get_league_or_404(league_id)
    team = league.teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if req.name is not None and req.name.strip():
        team.name = req.name.strip()[:48]
    if req.color:
        team.color = req.color
    store.save_league(league)
    return team


@router.delete("/leagues/{league_id}/teams/{team_id}")
def delete_team(league_id: str, team_id: str):
    league = _get_league_or_404(league_id)
    if team_id not in league.teams:
        raise HTTPException(status_code=404, detail="Team not found")
    del league.teams[team_id]
    store.save_league(league)
    return {"status": "deleted"}


# ---------- rosters ----------
@router.put("/leagues/{league_id}/teams/{team_id}/roster", response_model=Team)
def set_roster(league_id: str, team_id: str, req: SetRosterRequest):
    league = _get_league_or_404(league_id)
    team = league.teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    unknown = [pid for pid in req.player_ids if pid not in league.players]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown player ids: {unknown}")
    # A player can only be on one roster at a time.
    for other in league.teams.values():
        if other.id != team_id:
            other.player_ids = [p for p in other.player_ids if p not in req.player_ids]
    team.player_ids = list(dict.fromkeys(req.player_ids))
    store.save_league(league)
    return team


@router.post("/leagues/{league_id}/teams/{team_id}/roster", response_model=Team)
def add_to_roster(league_id: str, team_id: str, req: AddRosterRequest):
    league = _get_league_or_404(league_id)
    team = league.teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if req.player_id not in league.players:
        raise HTTPException(status_code=404, detail="Player not found")
    for other in league.teams.values():
        if other.id != team_id and req.player_id in other.player_ids:
            other.player_ids.remove(req.player_id)
    if req.player_id not in team.player_ids:
        team.player_ids.append(req.player_id)
    store.save_league(league)
    return team


@router.delete("/leagues/{league_id}/teams/{team_id}/roster/{player_id}", response_model=Team)
def remove_from_roster(league_id: str, team_id: str, player_id: str):
    league = _get_league_or_404(league_id)
    team = league.teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if player_id in team.player_ids:
        team.player_ids.remove(player_id)
    store.save_league(league)
    return team


# ---------- live games: seat links, teams, team scores ----------
@router.get("/games/{game_id}/link", response_model=LinkOut)
def get_game_link(game_id: str):
    game = _live_game_or_404(game_id)
    return _link_out(game, store.get_link(game_id))


@router.get("/games/{game_id}/link/suggest", response_model=LinkOut)
def suggest_game_link(game_id: str, league_id: str):
    game = _live_game_or_404(game_id)
    league = _get_league_or_404(league_id)
    seats = suggest_seats(game.state.players, league)
    preview = GameLink(game_id=game_id, league_id=league.id, seat_players=seats,
                       teams=teams_for_seats(league, seats))
    return _link_out(game, preview)


@router.put("/games/{game_id}/link", response_model=LinkOut)
def set_game_link(game_id: str, req: LinkRequest):
    game = _live_game_or_404(game_id)
    current = store.get_link(game_id)
    if current and current.recorded_record_id:
        raise HTTPException(status_code=400, detail="This game is already recorded to a league")
    if not req.league_id:
        link = GameLink(game_id=game_id)
        store.save_link(link)
        return _link_out(game, link)
    league = _get_league_or_404(req.league_id)
    n = len(game.state.players)
    seats: Dict[str, Optional[str]] = {}
    used = set()
    for seat in range(n):
        pid = req.seats.get(str(seat))
        if pid:
            if pid not in league.players:
                raise HTTPException(status_code=400, detail="Unknown league player")
            if pid in used:
                raise HTTPException(
                    status_code=400,
                    detail=f"{league.players[pid].name} is linked to two seats",
                )
            used.add(pid)
        seats[str(seat)] = pid or None
    link = GameLink(game_id=game_id, league_id=league.id, seat_players=seats,
                    teams=teams_for_seats(league, seats))
    store.save_link(link)
    return _link_out(game, link)


@router.post("/games/{game_id}/teams", response_model=List[GameTeam])
def assign_teams_to_game(game_id: str, req: AssignTeamsRequest):
    """Game-local custom teams by seat (used when the game is not linked to a league)."""
    game = _live_game_or_404(game_id)
    num_players = len(game.state.players)

    league = store.get_league(req.league_id) if req.league_id else None
    if req.league_id and not league:
        raise HTTPException(status_code=404, detail="League not found")

    seen: set = set()
    teams: List[GameTeam] = []
    for t in req.teams:
        idxs = [i for i in t.player_indices if 0 <= i < num_players]
        if not idxs:
            raise HTTPException(
                status_code=400, detail=f"Team '{t.name}' has no valid players"
            )
        dupes = seen.intersection(idxs)
        if dupes:
            names = [game.state.players[i] for i in dupes]
            raise HTTPException(
                status_code=400, detail=f"Players assigned twice: {names}"
            )
        seen.update(idxs)
        league_team = league.teams.get(t.id) if (league and t.id) else None
        teams.append(
            GameTeam(
                id=league_team.id if league_team else GameTeam(name=t.name).id,
                name=t.name.strip() or "Team",
                color=t.color or (league_team.color if league_team else "#4f8cff"),
                league_id=league.id if league else None,
                league_team_id=league_team.id if league_team else None,
                player_indices=idxs,
            )
        )
    store.set_game_teams(game_id, teams)
    return teams


@router.get("/games/{game_id}/teams", response_model=List[GameTeam])
def get_game_teams(game_id: str):
    _live_game_or_404(game_id)
    return store.get_game_teams(game_id)


@router.get("/games/{game_id}/team-scores", response_model=List[TeamScore])
def get_team_scores(game_id: str):
    game = _live_game_or_404(game_id)
    return compute_team_scores(game, store.get_game_teams(game_id))


# ---------- recorded results ----------
@router.post("/leagues/{league_id}/record", response_model=LeagueGameRecord)
def record_game_result(league_id: str, req: RecordGameRequest):
    league = _get_league_or_404(league_id)
    game = _live_game_or_404(req.game_id)

    if game.state.phase != "game_over":
        raise HTTPException(
            status_code=400, detail="Game is not over yet; record it after GAME_OVER"
        )
    if any(r.game_id == req.game_id for r in league.games):
        raise HTTPException(status_code=400, detail="Game already recorded")
    link = store.get_link(req.game_id)
    if link and link.recorded_record_id:
        raise HTTPException(status_code=400, detail="Game already recorded to a league")
    if link and link.league_id and link.league_id != league_id:
        raise HTTPException(status_code=400, detail="This game is linked to a different league")

    if link and link.league_id == league_id:
        seats, teams = link.seat_players, link.teams
    else:
        seats = suggest_seats(game.state.players, league)
        teams = (link.teams if link and link.teams else None) or teams_for_seats(league, seats)
    record = record_from_game(game, league, seats, teams)
    store.add_record(league_id, record)

    link = link or GameLink(game_id=req.game_id)
    link.league_id = league_id
    link.seat_players = seats
    link.teams = teams
    link.recorded_record_id = record.id
    store.save_link(link)
    return record


@router.get("/leagues/{league_id}/games", response_model=List[LeagueGameRecord])
def list_recorded_games(league_id: str):
    league = _get_league_or_404(league_id)
    return list(reversed(league.games))


@router.get("/leagues/{league_id}/games/{record_id}", response_model=LeagueGameRecord)
def get_recorded_game(league_id: str, record_id: str):
    _get_league_or_404(league_id)
    rec = store.get_record(league_id, record_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Result not found")
    return rec


@router.post("/leagues/{league_id}/games", response_model=LeagueGameRecord)
def add_manual_result(league_id: str, req: ResultIn):
    league = _get_league_or_404(league_id)
    players, rounds = _result_players(league, req)
    record = LeagueGameRecord(
        source="manual",
        played_at=_parse_played_at(req.played_at),
        rounds_played=len(rounds) or req.rounds_played,
        bidding_mode=req.bidding_mode or None,
        players=players,
        rounds=rounds,
        notes=req.notes.strip()[:500],
    )
    return store.add_record(league_id, finalize_record(record, league))


@router.put("/leagues/{league_id}/games/{record_id}", response_model=LeagueGameRecord)
def edit_result(league_id: str, record_id: str, req: ResultIn):
    league = _get_league_or_404(league_id)
    old = store.get_record(league_id, record_id)
    if not old:
        raise HTTPException(status_code=404, detail="Result not found")
    players, rounds = _result_players(league, req)
    old_by_pid = {p.league_player_id: p for p in old.players if p.league_player_id}
    for p in players:
        prev = old_by_pid.get(p.league_player_id)
        if prev is not None:
            if not rounds:
                p.seat = prev.seat
            if p.team_id is None:
                p.team_id = prev.team_id
    if not rounds and req.rounds is None:
        # No per-hand data sent: keep the old hands only if they still add up.
        same_lineup = {p.league_player_id for p in players} == set(old_by_pid) and \
            len(players) == len(old.players)
        finals = {ln.seat: ln.total for ln in old.rounds[-1].players} if old.rounds else {}
        if same_lineup and all(finals.get(p.seat) == p.score for p in players):
            rounds = old.rounds
    record = old.model_copy(update={
        "played_at": _parse_played_at(req.played_at) if req.played_at else old.played_at,
        "edited_at": datetime.now(timezone.utc).isoformat(),
        "rounds_played": len(rounds) or req.rounds_played,
        "bidding_mode": req.bidding_mode or None,
        "players": players,
        "rounds": rounds,
        "notes": req.notes.strip()[:500],
        "team_scores": {}, "winner_team_ids": [], "winner_team_id": None,
    })
    return store.replace_record(league_id, finalize_record(record, league))


@router.delete("/leagues/{league_id}/games/{record_id}")
def delete_result(league_id: str, record_id: str):
    _get_league_or_404(league_id)
    if not store.delete_record(league_id, record_id):
        raise HTTPException(status_code=404, detail="Result not found")
    return {"status": "deleted"}


# ---------- standings ----------
@router.get("/leagues/{league_id}/standings", response_model=List[StandingRow])
def get_standings(league_id: str):
    return team_standings(_get_league_or_404(league_id))


@router.get("/leagues/{league_id}/leaderboard", response_model=List[PlayerStatRow])
def get_leaderboard(league_id: str):
    return player_leaderboard(_get_league_or_404(league_id))
