"""In-memory registry of live Wizard games.

Game sessions are not persisted. A process restart drops every game,
including rejoin tokens. League data lives separately in league_store.
"""
from typing import Dict

from app.services.tracked_game import TrackedWizardGame

games: Dict[str, TrackedWizardGame] = {}
