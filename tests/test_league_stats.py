"""Player leaderboard, team standings, seat linking and live-game records."""
from app.models.game import BiddingMode, GamePhase
from app.models.league import League, LeagueGameRecord, LeaguePlayer, RecordPlayer, Team
from app.services.league_stats import (
    finalize_record,
    player_leaderboard,
    record_from_game,
    suggest_seats,
    team_standings,
    teams_for_seats,
)
from app.services.tracked_game import TrackedWizardGame


def _league():
    league = League(name="L")
    for pid, name in [("ada", "Ada"), ("bea", "Bea"), ("cal", "Cal"), ("dee", "Dee"), ("eli", "Eli")]:
        league.players[pid] = LeaguePlayer(id=pid, name=name)
    league.teams["hats"] = Team(id="hats", name="Hats", color="#7c4dff", player_ids=["ada", "bea"])
    league.teams["owls"] = Team(id="owls", name="Owls", color="#2f9e6a", player_ids=["cal", "dee"])
    return league


def _rec(league, lines, **kw):
    players = [RecordPlayer(name=league.players[pid].name if pid in league.players else pid,
                            league_player_id=pid if pid in league.players else None,
                            score=score, team_id=team, bids_made=made, rounds_bid=rounds)
               for pid, score, team, made, rounds in lines]
    return finalize_record(LeagueGameRecord(players=players, **kw), league)


def test_leaderboard_counts_wins_ties_best_and_bid_accuracy():
    league = _league()
    league.games = [
        _rec(league, [("ada", 120, "hats", 8, 10), ("cal", 60, "owls", 6, 10),
                      ("eli", 40, None, 5, 10), ("Guest", 200, None, None, None)]),
        _rec(league, [("ada", 50, "hats", 7, 10), ("eli", 50, None, 9, 10), ("dee", -20, "owls", 3, 10)]),
        _rec(league, [("eli", 90, None, None, None), ("bea", 10, "hats", None, None), ("cal", 0, "owls", None, None)]),
    ]
    rows = {r.player_id: r for r in player_leaderboard(league)}

    assert set(rows) == {"ada", "bea", "cal", "dee", "eli"}
    eli = rows["eli"]
    assert eli.team_id is None
    assert (eli.games_played, eli.wins, eli.ties) == (3, 1, 1)
    assert eli.best_score == 90 and eli.avg_score == 60.0
    assert eli.bid_accuracy == round(14 / 20, 3)
    ada = rows["ada"]
    assert (ada.games_played, ada.wins, ada.ties, ada.best_score) == (2, 0, 1, 120)
    assert ada.team_name == "Hats" and ada.bid_accuracy == 0.75
    assert rows["bea"].bid_accuracy is None


def test_leaderboard_lists_players_without_games_last():
    league = _league()
    league.players["new"] = LeaguePlayer(id="new", name="Newbie")
    league.games = [_rec(league, [("ada", 10, None, None, None), ("bea", 0, None, None, None),
                                  ("cal", -10, None, None, None)])]
    order = [r.player_id for r in player_leaderboard(league)]
    assert order[0] == "ada"
    assert set(order[-3:]) == {"dee", "eli", "new"}


def test_team_standings_mark_ties():
    league = _league()
    league.games = [
        _rec(league, [("ada", 50, "hats", None, None), ("cal", 50, "owls", None, None), ("eli", 0, None, None, None)]),
        _rec(league, [("ada", 90, "hats", None, None), ("cal", 10, "owls", None, None), ("eli", 0, None, None, None)]),
    ]
    assert league.games[0].team_tie and league.games[0].winner_team_id is None
    rows = {r.team_id: r for r in team_standings(league)}
    assert (rows["hats"].wins, rows["hats"].ties, rows["hats"].total_points) == (1, 1, 140)
    assert (rows["owls"].wins, rows["owls"].ties) == (0, 1)
    assert rows["hats"].player_ids == ["ada", "bea"]


def test_seats_link_by_name_and_teams_follow_people_not_seat_numbers():
    league = _league()
    seats = suggest_seats(["dee", "Stranger", " ADA ", "Ada", "cal"], league)
    assert seats == {"0": "dee", "1": None, "2": "ada", "3": None, "4": "cal"}
    teams = {t.id: t.player_indices for t in teams_for_seats(league, seats)}
    assert teams == {"owls": [0, 4], "hats": [2]}


def _play_to_end(game):
    game.start_game()
    for _ in range(20000):
        st = game.state
        if st.phase == GamePhase.GAME_OVER:
            return
        if st.phase == GamePhase.WAITING_TRUMP:
            assert game.choose_trump(st.current_player, "S")
        elif st.phase == GamePhase.BIDDING:
            for bid in range(st.current_round + 1):
                if game.submit_bid(st.current_player, bid)[0]:
                    break
        elif st.phase == GamePhase.PLAYING:
            p = st.current_player
            card = game.get_legal_plays(p)[0]
            assert game.play_card(p, st.hands[p].index(card))
        elif st.phase == GamePhase.ROUND_OVER:
            for i in range(len(st.players)):
                game.player_ready(i)
    raise AssertionError("game did not finish")


def test_record_from_real_game_snapshots_every_player():
    league = _league()
    game = TrackedWizardGame("live01", BiddingMode.SEQUENTIAL)
    for name in ["Cal", "Ada", "Zed", "Bea"]:
        game.add_player(name)
    _play_to_end(game)
    seats = suggest_seats(game.state.players, league)
    rec = record_from_game(game, league, seats, teams_for_seats(league, seats))

    assert rec.rounds_played == 15 and len(rec.rounds) == 15
    assert rec.bidding_mode == "sequential" and rec.source == "live"
    assert [p.name for p in rec.players] == ["Cal", "Ada", "Zed", "Bea"]
    assert [p.league_player_id for p in rec.players] == ["cal", "ada", None, "bea"]
    assert [p.team_id for p in rec.players] == ["owls", "hats", None, "hats"]
    assert [p.score for p in rec.players] == game.state.scores
    assert rec.team_scores == {"owls": game.state.scores[0],
                               "hats": game.state.scores[1] + game.state.scores[3]}
    for seat, p in enumerate(rec.players):
        made = sum(1 for h in game.history if h["bids"][str(seat)] == h["tricks"][seat])
        assert (p.bids_made, p.rounds_bid) == (made, 15)
