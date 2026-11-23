"""League persistence: JSON fallback, Firestore backend (faked), env selection."""
import base64
import json

import pytest

from app.models.league import LeagueGameRecord, RecordPlayer, RecordRound, RoundLine, Team
from app.services import league_firestore
from app.services.league_firestore import FirestoreBackend, load_service_account
from app.services.league_store import JsonBackend, LeagueStore, StoreError, backend_from_env
from fake_firestore import FakeFirestoreClient


def _lines(rows):
    names = ["Ada", "Bea", "Cal"]
    return [RoundLine(seat=i, name=names[i], bid=b, tricks=t, points=p, total=tot)
            for i, (b, t, p, tot) in enumerate(rows)]


def _populate(store: LeagueStore):
    league = store.create_league("Friday Night Wizards")
    ada = store.add_player(league, "Ada")
    bea = store.add_player(league, "Bea")
    cal = store.add_player(league, "Cal")
    team = Team(name="Pointy Hats", color="#7c4dff", player_ids=[ada.id, bea.id])
    league.teams[team.id] = team
    store.save_league(league)
    rec = LeagueGameRecord(
        game_id="abcd1234",
        bidding_mode="secret",
        rounds_played=2,
        players=[
            RecordPlayer(name="Ada", league_player_id=ada.id, seat=0, score=60, team_id=team.id,
                         bids_made=2, rounds_bid=2),
            RecordPlayer(name="Bea", league_player_id=bea.id, seat=1, score=-10, team_id=team.id,
                         bids_made=1, rounds_bid=2),
            RecordPlayer(name="Cal", league_player_id=cal.id, seat=2, score=30,
                         bids_made=1, rounds_bid=2),
        ],
        rounds=[
            RecordRound(round=1, cards_dealt=1, dealer_seat=2, dealer="Cal", trump="H", trump_source="flip",
                        players=_lines([(1, 1, 30, 30), (0, 0, 20, 20), (0, 0, 20, 20)])),
            RecordRound(round=2, cards_dealt=2, dealer_seat=0, dealer="Ada", trump="S", trump_source="wizard",
                        trump_chosen_by="Cal",
                        players=_lines([(1, 1, 30, 60), (1, 0, -30, -10), (1, 1, 10, 30)])),
        ],
        team_scores={team.id: 50},
        team_names={team.id: "Pointy Hats"},
        winner_team_ids=[team.id],
        winner_team_id=team.id,
    )
    store.add_record(league.id, rec)
    return league, rec


def _assert_round_trip(reloaded: LeagueStore, league, rec):
    got = reloaded.get_league(league.id)
    assert got is not None
    assert got.name == "Friday Night Wizards"
    assert {p.name for p in got.players.values()} == {"Ada", "Bea", "Cal"}
    assert [t.name for t in got.teams.values()] == ["Pointy Hats"]
    assert len(got.games) == 1
    saved = got.games[0]
    assert saved.id == rec.id
    assert saved.bidding_mode == "secret"
    assert [(p.name, p.score, p.bids_made) for p in saved.players] == [
        ("Ada", 60, 2), ("Bea", -10, 1), ("Cal", 30, 1),
    ]
    r2 = saved.rounds[1]
    assert (r2.round, r2.cards_dealt, r2.dealer, r2.trump, r2.trump_source, r2.trump_chosen_by) == \
        (2, 2, "Ada", "S", "wizard", "Cal")
    assert [(ln.name, ln.bid, ln.tricks, ln.points, ln.total) for ln in r2.players] == [
        ("Ada", 1, 1, 30, 60), ("Bea", 1, 0, -30, -10), ("Cal", 1, 1, 10, 30),
    ]
    assert [(p.name, p.place) for p in saved.players] == [("Ada", 1), ("Bea", 3), ("Cal", 2)]
    assert saved.final_only is False
    assert saved.winner_names == ["Ada"]


def test_json_backend_survives_restart(tmp_path):
    path = tmp_path / "league.json"
    league, rec = _populate(LeagueStore(JsonBackend(path)))
    _assert_round_trip(LeagueStore(JsonBackend(path)), league, rec)
    raw = json.loads(path.read_text())
    assert raw["version"] == 2
    assert "winner_names" not in raw["leagues"][league.id]["games"][0]


def test_firestore_game_document_shape():
    client = FakeFirestoreClient()
    store = LeagueStore(FirestoreBackend(client))
    league, rec = _populate(store)
    doc = client.docs[("leagues", league.id, "games", rec.id)]
    assert {"id", "game_id", "source", "played_at", "rounds_played", "bidding_mode", "players",
            "rounds", "final_only", "team_scores", "winner_team_ids"} <= set(doc)
    assert not {"winner_names", "player_tie", "team_tie"} & set(doc)
    assert set(doc["players"][0]) == {"name", "league_player_id", "seat", "score", "place", "team_id",
                                      "bids_made", "rounds_bid"}
    assert set(doc["rounds"][0]) == {"round", "cards_dealt", "dealer_seat", "dealer", "trump",
                                     "trump_source", "trump_chosen_by", "players"}
    assert doc["rounds"][1]["players"][1] == {"seat": 1, "name": "Bea", "bid": 1, "tricks": 0,
                                              "points": -30, "total": -10}
    assert doc["players"][0]["place"] == 1 and doc["final_only"] is False


def test_legacy_round_format_is_upgraded_with_running_totals():
    rec = LeagueGameRecord.model_validate({
        "players": [{"name": "Ada", "seat": 0, "score": 10}, {"name": "Bea", "seat": 1, "score": 40},
                    {"name": "Cal", "seat": 2, "score": 40}],
        "rounds": [
            {"round": 1, "bids": {"0": 0, "1": 1, "2": 0}, "tricks": [0, 1, 0], "deltas": [20, 30, 20]},
            {"round": 2, "bids": {"0": 1, "1": 0, "2": 0}, "tricks": [0, 1, 0], "deltas": [-10, 10, 20]},
        ],
    })
    assert [(ln.name, ln.points, ln.total) for ln in rec.rounds[1].players] == [
        ("Ada", -10, 10), ("Bea", 10, 40), ("Cal", 20, 40)]
    assert rec.rounds[0].players[1].bid == 1 and rec.rounds[0].cards_dealt == 1
    assert [p.place for p in rec.players] == [3, 1, 1]


def test_json_backend_deletes_records_and_leagues(tmp_path):
    path = tmp_path / "league.json"
    store = LeagueStore(JsonBackend(path))
    league, rec = _populate(store)
    assert store.delete_record(league.id, rec.id)
    assert LeagueStore(JsonBackend(path)).get_league(league.id).games == []
    assert store.delete_league(league.id)
    assert LeagueStore(JsonBackend(path)).list_leagues() == []


def test_json_backend_migrates_old_single_blob_file(tmp_path):
    path = tmp_path / "league.json"
    path.write_text(json.dumps({
        "leagues": {"L1": {
            "id": "L1", "name": "Old League", "created_at": "2026-10-24T00:00:00+00:00",
            "players": {}, "teams": {"T1": {"id": "T1", "name": "Hats", "color": "#123456", "player_ids": []}},
            "games": [{"game_id": "g1", "played_at": "2026-10-24T01:00:00+00:00",
                       "team_scores": {"T1": 40}, "team_names": {"T1": "Hats"}, "winner_team_id": "T1"}],
        }},
        "game_teams": {"g1": [{"id": "T1", "name": "Hats", "player_indices": [0]}]},
    }))
    first = LeagueStore(JsonBackend(path)).get_league("L1")
    second = LeagueStore(JsonBackend(path)).get_league("L1")
    assert first.games[0].id == second.games[0].id
    assert second.games[0].team_scores == {"T1": 40}
    assert json.loads(path.read_text())["version"] == 2


def test_firestore_backend_round_trip_and_layout():
    client = FakeFirestoreClient()
    store = LeagueStore(FirestoreBackend(client, prefix="test_"))
    league, rec = _populate(store)
    assert ("test_leagues", league.id) in client.docs
    assert ("test_leagues", league.id, "games", rec.id) in client.docs
    assert "games" not in client.docs[("test_leagues", league.id)]
    _assert_round_trip(LeagueStore(FirestoreBackend(client, prefix="test_")), league, rec)


def test_firestore_backend_cascades_league_delete():
    client = FakeFirestoreClient()
    store = LeagueStore(FirestoreBackend(client))
    league, rec = _populate(store)
    other = store.create_league("Other")
    store.delete_league(league.id)
    assert not any(path[1] == league.id for path in client.docs)
    assert ("leagues", other.id) in client.docs


def test_failed_write_resyncs_cache_and_raises():
    class FlakyBackend(JsonBackend):
        fail = False

        def put_record(self, league_id, record):
            if self.fail:
                raise ConnectionError("firestore down")
            super().put_record(league_id, record)

    import tempfile
    from pathlib import Path
    backend = FlakyBackend(Path(tempfile.mkdtemp()) / "l.json")
    store = LeagueStore(backend)
    league, _ = _populate(store)
    backend.fail = True
    with pytest.raises(StoreError):
        store.add_record(league.id, LeagueGameRecord(game_id="lost"))
    assert [r.game_id for r in store.get_league(league.id).games] == ["abcd1234"]


def test_migrate_json_file_into_firestore(tmp_path):
    from app.services.migrate_leagues import migrate

    path = tmp_path / "league.json"
    league, rec = _populate(LeagueStore(JsonBackend(path)))
    client = FakeFirestoreClient()
    assert migrate(path, FirestoreBackend(client)) == (1, 1)
    assert migrate(path, FirestoreBackend(client)) == (1, 1)
    _assert_round_trip(LeagueStore(FirestoreBackend(client)), league, rec)
    assert len(client.docs) == 2


SERVICE_ACCOUNT = {"type": "service_account", "project_id": "demo-wizard", "client_email": "x@y"}


def test_load_service_account_variants(tmp_path):
    b64 = base64.b64encode(json.dumps(SERVICE_ACCOUNT).encode()).decode()
    assert load_service_account({"FIREBASE_CREDENTIALS_B64": b64})["project_id"] == "demo-wizard"
    assert load_service_account({"FIREBASE_CREDENTIALS": json.dumps(SERVICE_ACCOUNT)})["client_email"] == "x@y"
    key = tmp_path / "sa.json"
    key.write_text(json.dumps(SERVICE_ACCOUNT))
    assert load_service_account({"FIREBASE_CREDENTIALS": str(key)}) == str(key)
    assert load_service_account({"GOOGLE_APPLICATION_CREDENTIALS": str(key)}) is None
    with pytest.raises(ValueError):
        load_service_account({"FIREBASE_CREDENTIALS": str(tmp_path / "missing.json")})
    with pytest.raises(ValueError):
        load_service_account({"FIREBASE_CREDENTIALS_B64": "not base64 json!"})


def test_backend_selection_from_env(tmp_path, monkeypatch):
    picked = []
    monkeypatch.setattr(league_firestore.FirestoreBackend, "from_env",
                        classmethod(lambda cls, env=None: picked.append(env) or "FIRESTORE"))
    data = str(tmp_path / "x.json")

    default = backend_from_env({"LEAGUE_DATA_FILE": data})
    assert isinstance(default, JsonBackend) and str(default.path) == data
    assert backend_from_env({"FIREBASE_CREDENTIALS_B64": "abc"}) == "FIRESTORE"
    assert backend_from_env({"GOOGLE_APPLICATION_CREDENTIALS": "/k.json"}) == "FIRESTORE"
    assert backend_from_env({"LEAGUE_STORE": "firestore"}) == "FIRESTORE"
    forced = backend_from_env({"LEAGUE_STORE": "json", "FIREBASE_CREDENTIALS": "{}", "LEAGUE_DATA_FILE": data})
    assert isinstance(forced, JsonBackend)
    with pytest.raises(ValueError):
        backend_from_env({"LEAGUE_STORE": "supabase"})


def test_real_firebase_admin_client_builds_from_base64_credentials(monkeypatch):
    pytest.importorskip("firebase_admin")
    rsa = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.rsa")
    from cryptography.hazmat.primitives import serialization

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    info = {
        "type": "service_account", "project_id": "demo-wizard-test",
        "private_key_id": "k1", "private_key": pem,
        "client_email": "league@demo-wizard-test.iam.gserviceaccount.com",
        "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token",
    }
    import firebase_admin
    monkeypatch.setattr(league_firestore, "APP_NAME", "wizard-league-unit-test")
    try:
        backend = FirestoreBackend.from_env({
            "FIREBASE_CREDENTIALS_B64": base64.b64encode(json.dumps(info).encode()).decode(),
            "FIRESTORE_COLLECTION_PREFIX": "dev_",
        })
        assert backend.client.project == "demo-wizard-test"
        assert backend.leagues_col == "dev_leagues"
    finally:
        firebase_admin.delete_app(firebase_admin.get_app("wizard-league-unit-test"))
