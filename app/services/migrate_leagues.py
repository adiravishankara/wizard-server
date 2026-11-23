"""Copy leagues from a JSON league file into Firestore.

    python -m app.services.migrate_leagues [path/to/wizard_league.json]

Uses the same Firebase environment variables as the server. Safe to re-run:
documents are written by id, so a second run overwrites rather than duplicates.
"""
import sys
from pathlib import Path

from app.services.league_store import STORE_FILE, JsonBackend


def migrate(source: Path, dest) -> tuple:
    leagues = JsonBackend(source).load()
    records = 0
    for league in leagues.values():
        dest.put_league(league)
        for rec in league.games:
            dest.put_record(league.id, rec)
            records += 1
    return len(leagues), records


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    source = Path(argv[0]) if argv else STORE_FILE
    if not source.exists():
        print(f"No league file at {source}")
        return 1
    from app.services.league_firestore import FirestoreBackend
    n_leagues, n_records = migrate(source, FirestoreBackend.from_env())
    print(f"Copied {n_leagues} leagues and {n_records} recorded games to Firestore.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
