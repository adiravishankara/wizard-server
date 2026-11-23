"""Derived league data: records built from live games, seat linking, standings.

Pure functions over the league models (and read-only access to a finished
game), so they are easy to test without a server.
"""
from typing import Dict, Iterable, List, Optional

from app.models.league import (
    GameTeam,
    League,
    LeagueGameRecord,
    PlayerStatRow,
    RecordPlayer,
    RecordRound,
    RoundLine,
    StandingRow,
    Team,
)


def _val(value):
    return value.value if hasattr(value, "value") else value


def team_of_player(league: League) -> Dict[str, Team]:
    out: Dict[str, Team] = {}
    for team in league.teams.values():
        for pid in team.player_ids:
            out[pid] = team
    return out


def suggest_seats(names: Iterable[str], league: League) -> Dict[str, Optional[str]]:
    """Match seat names to league players case-insensitively; each player once."""
    by_name = {p.name.strip().casefold(): p.id for p in league.players.values()}
    used = set()
    out: Dict[str, Optional[str]] = {}
    for seat, name in enumerate(names):
        pid = by_name.get(str(name).strip().casefold())
        if pid and pid not in used:
            used.add(pid)
            out[str(seat)] = pid
        else:
            out[str(seat)] = None
    return out


def teams_for_seats(league: League, seat_players: Dict[str, Optional[str]]) -> List[GameTeam]:
    """League teams for a game, with seats placed by who sits there, not seat number."""
    teams: Dict[str, GameTeam] = {}
    membership = team_of_player(league)
    for seat, pid in sorted(seat_players.items(), key=lambda kv: int(kv[0])):
        team = membership.get(pid) if pid else None
        if not team:
            continue
        gt = teams.get(team.id)
        if gt is None:
            gt = teams[team.id] = GameTeam(
                id=team.id, name=team.name, color=team.color,
                league_id=league.id, league_team_id=team.id, player_indices=[],
            )
        gt.player_indices.append(int(seat))
    return list(teams.values())


def _team_winners(rec: LeagueGameRecord) -> List[str]:
    if rec.winner_team_ids:
        return list(rec.winner_team_ids)
    return [rec.winner_team_id] if rec.winner_team_id else []


def finalize_record(rec: LeagueGameRecord, league: League) -> LeagueGameRecord:
    """Recompute team totals, winners and placings from the per-player lines."""
    rec.refresh()
    if not rec.players:
        return rec
    scores: Dict[str, int] = {}
    names: Dict[str, str] = dict(rec.team_names)
    colors: Dict[str, str] = dict(rec.team_colors)
    for p in rec.players:
        if not p.team_id:
            continue
        scores[p.team_id] = scores.get(p.team_id, 0) + p.score
        team = league.teams.get(p.team_id)
        if team:
            names[p.team_id] = team.name
            colors[p.team_id] = team.color
    rec.team_scores = scores
    rec.team_names = {tid: names.get(tid, "Team") for tid in scores}
    rec.team_colors = {tid: colors.get(tid, "#4f8cff") for tid in scores}
    if scores:
        top = max(scores.values())
        rec.winner_team_ids = [tid for tid, s in scores.items() if s == top]
    else:
        rec.winner_team_ids = []
    rec.winner_team_id = rec.winner_team_ids[0] if len(rec.winner_team_ids) == 1 else None
    return rec


def _round_from_history(h: dict, i: int, players: List[RecordPlayer]) -> RecordRound:
    names = [p.name for p in players]
    deltas = list(h.get("deltas") or [])
    totals = list(h.get("scores") or [])
    tricks = list(h.get("tricks") or [])
    bids = h.get("bids") or {}

    def name_at(seat):
        return names[seat] if seat is not None and 0 <= seat < len(names) else None

    running = 0
    lines = []
    for seat in range(len(names)):
        pts = deltas[seat] if seat < len(deltas) else 0
        lines.append(RoundLine(
            seat=seat,
            name=names[seat],
            bid=bids.get(str(seat)),
            tricks=tricks[seat] if seat < len(tricks) else None,
            points=pts,
            total=totals[seat] if seat < len(totals) else running + pts,
        ))
    rnd = h.get("round", i + 1)
    return RecordRound(
        round=rnd,
        cards_dealt=h.get("cards_dealt", rnd),
        dealer_seat=h.get("dealer"),
        dealer=name_at(h.get("dealer")),
        trump=h.get("trump"),
        trump_source=h.get("trump_source"),
        trump_chosen_by=name_at(h.get("trump_chosen_by")),
        players=lines,
    )


def record_from_game(game, league: League, seat_players: Dict[str, Optional[str]],
                     teams: List[GameTeam]) -> LeagueGameRecord:
    """Snapshot a finished game into a self-contained league record."""
    state = game.state
    history = list(getattr(game, "history", []) or [])
    seat_team: Dict[int, str] = {}
    for t in teams:
        for idx in t.player_indices:
            seat_team[idx] = t.league_team_id or t.id
    membership = team_of_player(league)

    players: List[RecordPlayer] = []
    for seat, name in enumerate(state.players):
        pid = seat_players.get(str(seat))
        if pid not in league.players:
            pid = None
        team_id = seat_team.get(seat)
        if team_id is None and pid and pid in membership:
            team_id = membership[pid].id
        made = rounds_bid = 0
        for h in history:
            bid = (h.get("bids") or {}).get(str(seat))
            tricks = h.get("tricks") or []
            if bid is None or seat >= len(tricks):
                continue
            rounds_bid += 1
            made += int(bid == tricks[seat])
        players.append(RecordPlayer(
            name=league.players[pid].name if pid else name,
            league_player_id=pid,
            seat=seat,
            score=state.scores[seat],
            team_id=team_id,
            bids_made=made if history else None,
            rounds_bid=rounds_bid if history else None,
        ))

    rec = LeagueGameRecord(
        game_id=state.game_id,
        source="live",
        rounds_played=len(history) or state.current_round,
        bidding_mode=_val(state.bidding_mode),
        players=players,
        rounds=[_round_from_history(h, i, players) for i, h in enumerate(history)],
    )
    for t in teams:
        tid = t.league_team_id or t.id
        rec.team_names[tid] = t.name
        rec.team_colors[tid] = t.color
    return finalize_record(rec, league)


def team_standings(league: League) -> List[StandingRow]:
    agg: Dict[str, dict] = {}

    def row(tid: str, name: str, color: str, members: List[str]) -> dict:
        return agg.setdefault(tid, {
            "name": name, "color": color, "players": members,
            "played": 0, "wins": 0, "ties": 0, "points": 0,
        })

    for team in league.teams.values():
        row(team.id, team.name, team.color, list(team.player_ids))
    for rec in league.games:
        winners = _team_winners(rec)
        for tid, pts in rec.team_scores.items():
            a = row(tid, rec.team_names.get(tid, tid), rec.team_colors.get(tid, "#4f8cff"), [])
            a["played"] += 1
            a["points"] += pts
            if tid in winners:
                if len(winners) == 1:
                    a["wins"] += 1
                else:
                    a["ties"] += 1

    rows = [
        StandingRow(
            team_id=tid, name=a["name"], color=a["color"], player_ids=a["players"],
            games_played=a["played"], wins=a["wins"], ties=a["ties"],
            total_points=a["points"],
            avg_points=round(a["points"] / a["played"], 1) if a["played"] else 0.0,
        )
        for tid, a in agg.items()
    ]
    rows.sort(key=lambda r: (r.wins, r.ties, r.total_points), reverse=True)
    return rows


def player_leaderboard(league: League) -> List[PlayerStatRow]:
    """Every league player, on a team or not. Guests in records are skipped."""
    membership = team_of_player(league)
    rows: Dict[str, PlayerStatRow] = {}
    for p in league.players.values():
        team = membership.get(p.id)
        rows[p.id] = PlayerStatRow(
            player_id=p.id, name=p.name,
            team_id=team.id if team else None,
            team_name=team.name if team else None,
            team_color=team.color if team else None,
        )
    for rec in league.games:
        if not rec.players:
            continue
        top = max(pl.score for pl in rec.players)
        n_top = sum(1 for pl in rec.players if pl.score == top)
        for pl in rec.players:
            row = rows.get(pl.league_player_id or "")
            if row is None:
                continue
            row.games_played += 1
            row.total_points += pl.score
            row.best_score = pl.score if row.best_score is None else max(row.best_score, pl.score)
            if pl.score == top:
                if n_top == 1:
                    row.wins += 1
                else:
                    row.ties += 1
            if pl.bids_made is not None and pl.rounds_bid:
                row.bids_made += pl.bids_made
                row.rounds_bid += pl.rounds_bid
    for row in rows.values():
        if row.games_played:
            row.avg_score = round(row.total_points / row.games_played, 1)
        if row.rounds_bid:
            row.bid_accuracy = round(row.bids_made / row.rounds_bid, 3)
    out = list(rows.values())
    out.sort(key=lambda r: (r.games_played > 0, r.wins, r.ties, r.avg_score, r.total_points),
             reverse=True)
    return out
