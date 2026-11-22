"""In-memory registry of live Wizard games.

Game sessions are not persisted. A process restart drops every game,
including rejoin tokens. League data lives separately in league_store.
"""
from typing import Dict

from app.core.game import WizardGame

games: Dict[str, WizardGame] = {}
