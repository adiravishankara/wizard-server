"""Firestore backend for the league store (firebase-admin).

Layout (all names take the optional ``FIRESTORE_COLLECTION_PREFIX``):

    leagues/{leagueId}                  name, created_at, players{}, teams{}
    leagues/{leagueId}/games/{recordId} one recorded result incl. per-player summary

Credentials, first match wins:

    FIREBASE_CREDENTIALS_B64        base64 of the service-account JSON (Render-friendly)
    FIREBASE_CREDENTIALS            the service-account JSON itself, or a path to it
    GOOGLE_APPLICATION_CREDENTIALS  path to the JSON (Application Default Credentials)

``FIREBASE_PROJECT_ID`` overrides the project taken from the credentials.
"""
import base64
import binascii
import json
import os
from typing import Dict, Optional, Union

from app.models.league import League, LeagueGameRecord
from app.services.league_store import league_doc, record_doc

APP_NAME = "wizard-league"


def load_service_account(env) -> Optional[Union[dict, str]]:
    """Service-account info as a dict, a file path, or None for ADC."""
    b64 = (env.get("FIREBASE_CREDENTIALS_B64") or "").strip()
    if b64:
        try:
            return json.loads(base64.b64decode(b64, validate=False).decode("utf-8"))
        except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("FIREBASE_CREDENTIALS_B64 is not base64-encoded service-account JSON") from exc
    raw = (env.get("FIREBASE_CREDENTIALS") or "").strip()
    if raw:
        if raw.startswith("{"):
            try:
                return json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError("FIREBASE_CREDENTIALS is not valid JSON") from exc
        if not os.path.isfile(raw):
            raise ValueError(f"FIREBASE_CREDENTIALS points to a missing file: {raw}")
        return raw
    return None


class FirestoreBackend:
    name = "firestore"

    def __init__(self, client, prefix: str = ""):
        self.client = client
        self.leagues_col = f"{prefix}leagues"

    @classmethod
    def from_env(cls, env=None) -> "FirestoreBackend":
        env = os.environ if env is None else env
        try:
            import firebase_admin
            from firebase_admin import credentials, firestore
        except ImportError as exc:
            raise RuntimeError(
                "Firestore storage needs firebase-admin: pip install '.[firebase]'"
            ) from exc
        info = load_service_account(env)
        cred = credentials.Certificate(info) if info else credentials.ApplicationDefault()
        project = (env.get("FIREBASE_PROJECT_ID") or "").strip()
        if not project and isinstance(info, dict):
            project = info.get("project_id", "")
        try:
            app = firebase_admin.get_app(APP_NAME)
        except ValueError:
            app = firebase_admin.initialize_app(
                cred, {"projectId": project} if project else None, name=APP_NAME
            )
        return cls(firestore.client(app), (env.get("FIRESTORE_COLLECTION_PREFIX") or "").strip())

    def _leagues(self):
        return self.client.collection(self.leagues_col)

    def _games(self, league_id: str):
        return self._leagues().document(league_id).collection("games")

    def load(self) -> Dict[str, League]:
        out: Dict[str, League] = {}
        for snap in self._leagues().stream():
            data = snap.to_dict() or {}
            league = League(**{**data, "id": snap.id, "games": []})
            records = [
                LeagueGameRecord(**{**(g.to_dict() or {}), "id": g.id})
                for g in self._games(snap.id).stream()
            ]
            league.games = sorted(records, key=lambda r: r.played_at)
            out[league.id] = league
        return out

    def put_league(self, league: League) -> None:
        self._leagues().document(league.id).set(league_doc(league))

    def delete_league(self, league_id: str) -> None:
        games = self._games(league_id)
        for snap in games.stream():
            games.document(snap.id).delete()
        self._leagues().document(league_id).delete()

    def put_record(self, league_id: str, record: LeagueGameRecord) -> None:
        self._games(league_id).document(record.id).set(record_doc(record))

    def delete_record(self, league_id: str, record_id: str) -> None:
        self._games(league_id).document(record_id).delete()
