from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from typing import Dict, List, Optional
from pydantic import BaseModel
import uuid

from app.core.game import WizardGame
from app.models.game import BiddingMode, GamePhase
from app.services.connection_manager import manager

router = APIRouter()

# In-memory storage for active games
games: Dict[str, WizardGame] = {}

class JoinRequest(BaseModel):
    name: str
    game_id: Optional[str] = None
    bidding_mode: BiddingMode = BiddingMode.SEQUENTIAL

class ActionRequest(BaseModel):
    player_id: int
    action: str # "bid", "play", "choose_trump"
    value: int # bid amount or card index
    suit: Optional[str] = None # for choosing trump

@router.post("/join")
async def join_game(request: JoinRequest):
    if request.game_id and request.game_id in games:
        game = games[request.game_id]
        player_idx = game.add_player(request.name)
        if player_idx == -1:
            raise HTTPException(status_code=400, detail="Game full or already started")
        await manager.broadcast_state(request.game_id, game)
        return {"game_id": request.game_id, "player_id": player_idx}
    else:
        # Create new game
        game_id = str(uuid.uuid4())[:8]
        game = WizardGame(game_id, request.bidding_mode)
        player_idx = game.add_player(request.name)
        games[game_id] = game
        # No broadcast needed for the very first player since they just joined and no one else is there
        return {"game_id": game_id, "player_id": player_idx}

@router.post("/{game_id}/start")
async def start_game(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    if game.start_game():
        await manager.broadcast_state(game_id, game)
        return {"status": "started"}
    else:
        raise HTTPException(status_code=400, detail="Need at least 3 players to start")

@router.post("/{game_id}/action")
async def game_action(game_id: str, request: ActionRequest):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    
    success = False
    error_detail = "Invalid action"
    
    if request.action == "bid":
        success = game.submit_bid(request.player_id, request.value)
        if not success:
            error_detail = f"Invalid bid. Must be between 0 and {game.state.current_round}."
    elif request.action == "play":
        # Check why it's invalid
        hand = game.state.hands.get(request.player_id, [])
        if not (0 <= request.value < len(hand)):
            error_detail = "Invalid card index."
        else:
            card = hand[request.value]
            legal_cards = game.get_legal_plays(request.player_id)
            if card not in legal_cards:
                if game.state.lead_suit and card.suit != game.state.lead_suit and card.type == CardType.REGULAR:
                    error_detail = f"Must follow suit! Lead suit is {game.state.lead_suit}."
                else:
                    error_detail = "This card cannot be played now."
            else:
                success = game.play_card(request.player_id, request.value)
    elif request.action == "choose_trump":
        success = game.choose_trump(request.player_id, request.suit)
        if not success:
            error_detail = "Only the dealer can choose trump, and it must be a valid suit."
    
    if success:
        await manager.broadcast_state(game_id, game)
        return {"status": "success"}
    else:
        raise HTTPException(status_code=400, detail=error_detail)

@router.websocket("/ws/{game_id}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str, player_id: int):
    if game_id not in games:
        await websocket.close(code=1008)
        return
    
    game = games[game_id]
    await manager.connect(game_id, player_id, websocket)
    
    # Send initial state
    await websocket.send_json(game.get_player_state(player_id).dict())
    
    try:
        while True:
            # We mostly use WebSocket for downstream updates.
            # Upstream can be HTTP or WS. For simplicity let's listen for ping or actions.
            data = await websocket.receive_text()
            # Handle incoming messages if needed
    except WebSocketDisconnect:
        manager.disconnect(game_id, player_id)
