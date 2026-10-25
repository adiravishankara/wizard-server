"""League, team, roster and team-scoring API.

Read-only with respect to the game engine: team scores are derived from the
live game state owned by app.routers.game, which this module never mutates.
"""
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.models.league import (
    GameTeam,
    League,
    LeagueGameRecord,
    LeaguePlayer,
    StandingRow,
    Team,
    TeamScore,
)
from app.services.league_store import store

router = APIRouter()


# ---------- request bodies ----------
class CreateLeagueRequest(BaseModel):
    name: str


class CreatePlayerRequest(BaseModel):
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


class RecordGameRequest(BaseModel):
    game_id: str


# ---------- helpers ----------
def _get_league_or_404(league_id: str) -> League:
    league = store.get_league(league_id)
    if not league:
        raise HTTPException(status_code=404, detail="League not found")
    return league


def _live_game_or_404(game_id: str):
    # Import here to avoid any import cycles at module load.
    from app.routers.game import games

    game = games.get(game_id)
    if not game:
        raise HTTPException(
            status_code=404,
            detail="Game not found (games are in-memory; it may have ended or the server restarted)",
        )
    return game


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


# ---------- leagues ----------
@router.post("/leagues", response_model=League)
async def create_league(req: CreateLeagueRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="League name is required")
    return store.create_league(name)


@router.get("/leagues", response_model=List[League])
async def list_leagues():
    return store.list_leagues()


@router.get("/leagues/{league_id}", response_model=League)
async def get_league(league_id: str):
    return _get_league_or_404(league_id)


@router.delete("/leagues/{league_id}")
async def delete_league(league_id: str):
    if not store.delete_league(league_id):
        raise HTTPException(status_code=404, detail="League not found")
    return {"status": "deleted"}


# ---------- league players ----------
@router.post("/leagues/{league_id}/players", response_model=LeaguePlayer)
async def add_league_player(league_id: str, req: CreatePlayerRequest):
    league = _get_league_or_404(league_id)
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Player name is required")
    player = LeaguePlayer(name=name)
    league.players[player.id] = player
    store.save()
    return player


@router.delete("/leagues/{league_id}/players/{player_id}")
async def remove_league_player(league_id: str, player_id: str):
    league = _get_league_or_404(league_id)
    if player_id not in league.players:
        raise HTTPException(status_code=404, detail="Player not found")
    del league.players[player_id]
    for team in league.teams.values():
        if player_id in team.player_ids:
            team.player_ids.remove(player_id)
    store.save()
    return {"status": "removed"}


# ---------- league teams ----------
@router.post("/leagues/{league_id}/teams", response_model=Team)
async def create_team(league_id: str, req: CreateTeamRequest):
    league = _get_league_or_404(league_id)
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Team name is required")
    team = Team(name=name, color=req.color or "#4f8cff")
    league.teams[team.id] = team
    store.save()
    return team


@router.put("/leagues/{league_id}/teams/{team_id}", response_model=Team)
async def update_team(league_id: str, team_id: str, req: UpdateTeamRequest):
    league = _get_league_or_404(league_id)
    team = league.teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if req.name is not None and req.name.strip():
        team.name = req.name.strip()
    if req.color:
        team.color = req.color
    store.save()
    return team


@router.delete("/leagues/{league_id}/teams/{team_id}")
async def delete_team(league_id: str, team_id: str):
    league = _get_league_or_404(league_id)
    if team_id not in league.teams:
        raise HTTPException(status_code=404, detail="Team not found")
    del league.teams[team_id]
    store.save()
    return {"status": "deleted"}


# ---------- rosters ----------
@router.put("/leagues/{league_id}/teams/{team_id}/roster", response_model=Team)
async def set_roster(league_id: str, team_id: str, req: SetRosterRequest):
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
    store.save()
    return team


@router.post("/leagues/{league_id}/teams/{team_id}/roster", response_model=Team)
async def add_to_roster(league_id: str, team_id: str, req: AddRosterRequest):
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
    store.save()
    return team


@router.delete("/leagues/{league_id}/teams/{team_id}/roster/{player_id}", response_model=Team)
async def remove_from_roster(league_id: str, team_id: str, player_id: str):
    league = _get_league_or_404(league_id)
    team = league.teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if player_id in team.player_ids:
        team.player_ids.remove(player_id)
    store.save()
    return team


# ---------- per-game team assignments & scoring ----------
@router.post("/games/{game_id}/teams", response_model=List[GameTeam])
async def assign_teams_to_game(game_id: str, req: AssignTeamsRequest):
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
                # Reuse the league team's id when linked, so results recorded
                # to the league aggregate under the same team across games.
                id=league_team.id if league_team else GameTeam().id,
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
async def get_game_teams(game_id: str):
    _live_game_or_404(game_id)
    return store.get_game_teams(game_id)


@router.get("/games/{game_id}/team-scores", response_model=List[TeamScore])
async def get_team_scores(game_id: str):
    game = _live_game_or_404(game_id)
    return compute_team_scores(game, store.get_game_teams(game_id))


# ---------- recording results & standings ----------
@router.post("/leagues/{league_id}/record", response_model=LeagueGameRecord)
async def record_game_result(league_id: str, req: RecordGameRequest):
    league = _get_league_or_404(league_id)
    game = _live_game_or_404(req.game_id)

    if game.state.phase != "game_over":
        raise HTTPException(
            status_code=400, detail="Game is not over yet; record it after GAME_OVER"
        )
    if any(r.game_id == req.game_id for r in league.games):
        raise HTTPException(status_code=400, detail="Game already recorded")

    teams = store.get_game_teams(req.game_id)
    scores = compute_team_scores(game, teams)
    team_scores = {s.team_id: s.score for s in scores}
    team_names = {s.team_id: s.name for s in scores}
    winner = None
    if scores:
        top = max(s.score for s in scores)
        leaders = [s.team_id for s in scores if s.score == top]
        winner = leaders[0] if len(leaders) == 1 else None  # tie: no winner

    record = LeagueGameRecord(
        game_id=req.game_id,
        rounds_played=game.state.current_round,
        team_scores=team_scores,
        team_names=team_names,
        winner_team_id=winner,
    )
    league.games.append(record)
    store.save()
    return record


@router.get("/leagues/{league_id}/games", response_model=List[LeagueGameRecord])
async def list_recorded_games(league_id: str):
    league = _get_league_or_404(league_id)
    return list(reversed(league.games))


@router.get("/leagues/{league_id}/standings", response_model=List[StandingRow])
async def get_standings(league_id: str):
    league = _get_league_or_404(league_id)
    agg: Dict[str, Dict] = {}
    for team in league.teams.values():
        agg[team.id] = {
            "name": team.name,
            "color": team.color,
            "played": 0,
            "wins": 0,
            "points": 0,
        }
    for rec in league.games:
        for tid, pts in rec.team_scores.items():
            if tid not in agg:
                agg[tid] = {
                    "name": rec.team_names.get(tid, tid),
                    "color": "#4f8cff",
                    "played": 0,
                    "wins": 0,
                    "points": 0,
                }
            agg[tid]["played"] += 1
            agg[tid]["points"] += pts
            if rec.winner_team_id == tid:
                agg[tid]["wins"] += 1

    rows = [
        StandingRow(
            team_id=tid,
            name=a["name"],
            color=a["color"],
            games_played=a["played"],
            wins=a["wins"],
            total_points=a["points"],
            avg_points=round(a["points"] / a["played"], 1) if a["played"] else 0.0,
        )
        for tid, a in agg.items()
    ]
    rows.sort(key=lambda r: (r.wins, r.total_points), reverse=True)
    return rows
