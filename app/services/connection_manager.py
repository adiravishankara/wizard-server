from typing import List, Dict
from fastapi import WebSocket
import json
from app.models.game import PlayerState

class ConnectionManager:
    def __init__(self):
        # game_id -> {player_idx: websocket}
        self.active_connections: Dict[str, Dict[int, WebSocket]] = {}

    async def connect(self, game_id: str, player_idx: int, websocket: WebSocket):
        await websocket.accept()
        if game_id not in self.active_connections:
            self.active_connections[game_id] = {}
        self.active_connections[game_id][player_idx] = websocket

    def disconnect(self, game_id: str, player_idx: int):
        if game_id in self.active_connections:
            if player_idx in self.active_connections[game_id]:
                del self.active_connections[game_id][player_idx]
            if not self.active_connections[game_id]:
                del self.active_connections[game_id]

    async def broadcast_state(self, game_id: str, game_instance):
        """Broadcast redacted state to each player individually."""
        if game_id in self.active_connections:
            for player_idx, websocket in self.active_connections[game_id].items():
                player_state = game_instance.get_player_state(player_idx)
                await websocket.send_json(player_state.dict())

manager = ConnectionManager()
