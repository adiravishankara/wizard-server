from typing import Dict, Optional

from fastapi import WebSocket

from app.services.player_view import player_state_dict


class ConnectionManager:
    def __init__(self):
        # game_id -> {player_idx: websocket}
        self.active_connections: Dict[str, Dict[int, WebSocket]] = {}

    async def connect(self, game_id: str, player_idx: int, websocket: WebSocket):
        await websocket.accept()
        if game_id not in self.active_connections:
            self.active_connections[game_id] = {}
        old = self.active_connections[game_id].get(player_idx)
        self.active_connections[game_id][player_idx] = websocket
        if old is not None and old is not websocket:
            try:
                await old.close(code=1000)
            except Exception:
                pass

    def disconnect(
        self,
        game_id: str,
        player_idx: int,
        websocket: Optional[WebSocket] = None,
    ):
        """Drop a socket only if it is still the player's current connection.

        Reconnects replace the stored websocket. The previous handler's
        disconnect must not delete the new socket, or only the last player
        to fully idle before reconnecting would stay subscribed.
        """
        if game_id not in self.active_connections:
            return
        conns = self.active_connections[game_id]
        current = conns.get(player_idx)
        if websocket is not None and current is not websocket:
            # The socket may have moved seats after a lobby shuffle.
            moved = [idx for idx, ws in conns.items() if ws is websocket]
            if not moved:
                return
            player_idx = moved[0]
        elif current is None:
            return
        del conns[player_idx]
        if not self.active_connections[game_id]:
            del self.active_connections[game_id]

    def remap(self, game_id: str, old_to_new: Dict[int, int]) -> None:
        """Move sockets to their new seats after the lobby order changes."""
        conns = self.active_connections.get(game_id)
        if not conns:
            return
        self.active_connections[game_id] = {
            old_to_new.get(idx, idx): ws for idx, ws in conns.items()
        }

    async def broadcast_state(self, game_id: str, game_instance):
        """Broadcast redacted state to each player individually."""
        conns = self.active_connections.get(game_id)
        if not conns:
            return
        for player_idx, websocket in list(conns.items()):
            try:
                await websocket.send_json(player_state_dict(game_instance, player_idx))
            except Exception:
                self.disconnect(game_id, player_idx, websocket)


manager = ConnectionManager()
