"""Keep a game's league/team link in step with lobby seat changes."""
from typing import Dict

from app.models.league import GameLink, GameTeam
from app.services.league_stats import teams_for_seats
from app.services.league_store import store


def remap_link_seats(game_id: str, old_to_new: Dict[int, int]) -> None:
    link = store.get_link(game_id)
    if not link:
        return
    link.seat_players = {
        str(old_to_new[int(seat)]): pid
        for seat, pid in link.seat_players.items()
        if int(seat) in old_to_new
    }
    for team in link.teams:
        team.player_indices = sorted(old_to_new[i] for i in team.player_indices if i in old_to_new)
    store.save_link(link)


def carry_link(old_game, new_game) -> None:
    """Copy the previous game's league or custom teams onto the rematch, by player name.

    Seats the rematch already has a mapping for are left alone, so a change
    made in the new lobby is not undone when someone else joins.
    """
    old = store.get_link(old_game.state.game_id)
    if not old or (not old.league_id and not old.teams):
        return
    old_names = old_game.state.players
    new_names = new_game.state.players
    new_id = new_game.state.game_id
    current = store.get_link(new_id)

    if old.league_id:
        league = store.get_league(old.league_id)
        if not league:
            return
        if current and current.league_id != old.league_id:
            return
        by_name = {
            old_names[int(seat)]: pid
            for seat, pid in old.seat_players.items()
            if int(seat) < len(old_names)
        }
        seats = dict(current.seat_players) if current else {}
        for seat, name in enumerate(new_names):
            seats.setdefault(str(seat), by_name.get(name))
        store.save_link(GameLink(
            game_id=new_id, league_id=league.id, seat_players=seats,
            teams=teams_for_seats(league, seats),
        ))
        return

    if current and current.league_id:
        return
    teams = []
    for t in old.teams:
        members = {old_names[i] for i in t.player_indices if i < len(old_names)}
        teams.append(GameTeam(
            **t.model_dump(exclude={"id", "player_indices"}),
            id=t.id,
            player_indices=[i for i, name in enumerate(new_names) if name in members],
        ))
    store.set_game_teams(new_id, teams)
