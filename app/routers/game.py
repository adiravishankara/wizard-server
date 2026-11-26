from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from typing import Optional
from pydantic import BaseModel
import uuid

from app.models.game import BiddingMode, CardType
from app.services.connection_manager import manager
from app.services.game_store import games
from app.services.league_links import carry_link, remap_link_seats
from app.services.lobby import get_meta, is_host, peek_meta, phase_of, shuffle_seats
from app.services.player_view import player_state_dict
from app.services.tracked_game import TrackedWizardGame
from app.services.trick_hold import clear_hold, set_hold

router = APIRouter()


class JoinRequest(BaseModel):
    name: str
    game_id: Optional[str] = None
    bidding_mode: BiddingMode = BiddingMode.SEQUENTIAL

class RejoinRequest(BaseModel):
    game_id: str
    token: str

class TokenRequest(BaseModel):
    token: str


class RematchRequest(BaseModel):
    token: str
    shuffle: bool = True


class LobbySettingsRequest(BaseModel):
    token: str
    shuffle_on_start: Optional[bool] = None
    bidding_mode: Optional[BiddingMode] = None


class ActionRequest(BaseModel):
    player_id: int
    action: str # "bid", "play", "choose_trump"
    value: int # bid amount or card index
    suit: Optional[str] = None # for choosing trump

@router.post("/join")
async def join_game(request: JoinRequest):
    if request.game_id:
        if request.game_id not in games:
            raise HTTPException(status_code=404, detail="Game not found")
        game = games[request.game_id]
        player_idx = game.add_player(request.name)
        if player_idx == -1:
            raise HTTPException(status_code=400, detail="Game full or already started")

        # Generate session token
        token = str(uuid.uuid4())
        game.state.player_tokens[token] = player_idx

        await manager.broadcast_state(request.game_id, game)
        return {"game_id": request.game_id, "player_id": player_idx, "token": token}

    # Create new game
    game_id = str(uuid.uuid4())[:8]
    game = TrackedWizardGame(game_id, request.bidding_mode)
    player_idx = game.add_player(request.name)
    games[game_id] = game

    # Generate session token
    token = str(uuid.uuid4())
    game.state.player_tokens[token] = player_idx
    get_meta(game_id).host_token = token

    # No broadcast needed for the very first player since they just joined and no one else is there
    return {"game_id": game_id, "player_id": player_idx, "token": token}

@router.post("/rejoin")
async def rejoin_game(request: RejoinRequest):
    if request.game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[request.game_id]

    if request.token not in game.state.player_tokens:
        raise HTTPException(status_code=403, detail="Invalid session token")

    player_idx = game.state.player_tokens[request.token]

    # We don't necessarily need to broadcast on rejoin, but we could to notify others they are back?
    # For now, just return the info needed to reconnect
    return {
        "game_id": request.game_id,
        "player_id": player_idx,
        "token": request.token,
        "name": game.state.players[player_idx]
    }


@router.get("/{game_id}/join-info")
async def join_info(game_id: str):
    """Public peek used by shareable join links before a friend enters their name."""
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    phase = phase_of(game)
    n = len(game.state.players)
    open_ = phase == "lobby" and n < 6
    if open_:
        detail = None
    elif phase != "lobby":
        detail = "This game has already started"
    else:
        detail = "This game is full"
    return {
        "game_id": game_id,
        "phase": phase,
        "players": n,
        "open": open_,
        "detail": detail,
    }


@router.post("/{game_id}/start")
async def start_game(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    meta = peek_meta(game_id)
    if meta and meta.shuffle_on_start and phase_of(game) == "lobby" and len(game.state.players) >= 3:
        _apply_shuffle(game)
    if game.start_game():
        clear_hold(game_id)
        await manager.broadcast_state(game_id, game)
        return {"status": "started"}
    else:
        raise HTTPException(status_code=400, detail="Need at least 3 players to start")

def _game_or_404(game_id: str):
    game = games.get(game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return game


def _apply_shuffle(game):
    gid = game.state.game_id
    old_to_new = shuffle_seats(game)
    manager.remap(gid, old_to_new)
    remap_link_seats(gid, old_to_new)
    return old_to_new


@router.post("/{game_id}/shuffle")
async def shuffle_lobby(game_id: str, request: TokenRequest):
    game = _game_or_404(game_id)
    if not is_host(game, request.token):
        raise HTTPException(status_code=403, detail="Only the host can shuffle seats")
    if phase_of(game) != "lobby":
        raise HTTPException(status_code=400, detail="Seats can only be shuffled before the game starts")
    _apply_shuffle(game)
    await manager.broadcast_state(game_id, game)
    return {"players": game.state.players, "player_id": game.state.player_tokens[request.token]}


@router.post("/{game_id}/lobby-settings")
async def lobby_settings(game_id: str, request: LobbySettingsRequest):
    game = _game_or_404(game_id)
    if not is_host(game, request.token):
        raise HTTPException(status_code=403, detail="Only the host can change lobby settings")
    if phase_of(game) != "lobby":
        raise HTTPException(status_code=400, detail="Lobby settings can only change before the game starts")
    meta = get_meta(game_id)
    if request.shuffle_on_start is not None:
        meta.shuffle_on_start = request.shuffle_on_start
    if request.bidding_mode is not None:
        game.state.bidding_mode = request.bidding_mode
    await manager.broadcast_state(game_id, game)
    return {
        "shuffle_on_start": meta.shuffle_on_start,
        "bidding_mode": getattr(game.state.bidding_mode, "value", game.state.bidding_mode),
    }


async def _join_rematch(old, new, token: str):
    old_meta = get_meta(old.state.game_id)
    new_id = new.state.game_id
    existing = old_meta.rematch_tokens.get(token)
    if existing and existing in new.state.player_tokens:
        seat = new.state.player_tokens[existing]
        return {"game_id": new_id, "player_id": seat, "token": existing, "name": new.state.players[seat]}
    name = old.state.players[old.state.player_tokens[token]]
    seat = new.add_player(name)
    if seat == -1:
        raise HTTPException(status_code=400, detail="The rematch has already started or is full")
    new_token = str(uuid.uuid4())
    new.state.player_tokens[new_token] = seat
    old_meta.rematch_tokens[token] = new_token
    new_meta = get_meta(new_id)
    if new_meta.host_token is None:
        new_meta.host_token = new_token
    carry_link(old, new)
    await manager.broadcast_state(new_id, new)
    await manager.broadcast_state(old.state.game_id, old)
    return {"game_id": new_id, "player_id": seat, "token": new_token, "name": name}


@router.post("/{game_id}/rematch")
async def create_rematch(game_id: str, request: RematchRequest):
    old = _game_or_404(game_id)
    if request.token not in old.state.player_tokens:
        raise HTTPException(status_code=403, detail="Invalid session token")
    if phase_of(old) != "game_over":
        raise HTTPException(status_code=400, detail="A rematch can start once the game is over")
    meta = get_meta(game_id)
    new = games.get(meta.rematch_id) if meta.rematch_id else None
    if new is None:
        new_id = str(uuid.uuid4())[:8]
        new = TrackedWizardGame(new_id, old.state.bidding_mode)
        games[new_id] = new
        new_meta = get_meta(new_id)
        new_meta.rematch_of = game_id
        new_meta.expected = list(old.state.players)
        new_meta.shuffle_on_start = request.shuffle
        meta.rematch_id = new_id
    return await _join_rematch(old, new, request.token)


@router.post("/{game_id}/rematch/join")
async def join_rematch(game_id: str, request: TokenRequest):
    old = _game_or_404(game_id)
    if request.token not in old.state.player_tokens:
        raise HTTPException(status_code=403, detail="Invalid session token")
    meta = get_meta(game_id)
    new = games.get(meta.rematch_id) if meta.rematch_id else None
    if new is None:
        raise HTTPException(status_code=404, detail="No rematch has been started for this game")
    return await _join_rematch(old, new, request.token)


@router.post("/{game_id}/ready")
async def player_ready(game_id: str, request: ActionRequest):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]

    if game.player_ready(request.player_id):
        if getattr(game.state.phase, "value", game.state.phase) != "round_over":
            clear_hold(game_id)
        await manager.broadcast_state(game_id, game)
        return {"status": "success"}
    else:
        raise HTTPException(status_code=400, detail="Not in round over phase or invalid player")

@router.post("/{game_id}/action")
async def game_action(game_id: str, request: ActionRequest):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]

    success = False
    error_detail = "Invalid action"

    if request.action == "bid":
        success, error_detail = game.submit_bid(request.player_id, request.value)
    elif request.action == "play":
        # Never trust the client: validate turn + legality before mutating.
        phase = getattr(game.state.phase, "value", game.state.phase)
        hand = game.state.hands.get(request.player_id, [])
        if phase != "playing":
            error_detail = "Not in the playing phase."
        elif request.player_id != game.state.current_player:
            waiting = game.state.players[game.state.current_player]
            error_detail = f"Not your turn to play. Waiting for {waiting}."
        elif not (0 <= request.value < len(hand)):
            error_detail = "Invalid card index."
        else:
            card = hand[request.value]
            legal_cards = game.get_legal_plays(request.player_id)
            if card not in legal_cards:
                lead = game.state.lead_suit
                ctype = getattr(card.type, "value", card.type)
                if lead and ctype == "regular" and card.suit != lead:
                    error_detail = f"Must follow suit ({lead})."
                else:
                    error_detail = "This card cannot be played now."
            else:
                would_complete = (
                    len(game.state.current_trick) + 1 == len(game.state.players)
                )
                completed = (
                    list(game.state.current_trick) + [(request.player_id, card)]
                    if would_complete
                    else None
                )
                success = game.play_card(request.player_id, request.value)
                if success:
                    if completed:
                        set_hold(game_id, completed)
                    else:
                        clear_hold(game_id)
                else:
                    error_detail = "Play rejected."
    elif request.action == "choose_trump":
        success = game.choose_trump(request.player_id, request.suit)
        if not success:
            players = game.state.players
            chooser = (
                players[(game.state.dealer_idx - 1) % len(players)]
                if players else "the player right of the dealer"
            )
            error_detail = f"Only {chooser} can choose trump, and it must be a valid suit."

    if success:
        await manager.broadcast_state(game_id, game)
        return {"status": "success"}
    else:
        raise HTTPException(status_code=400, detail=error_detail)

@router.websocket("/ws/{game_id}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str, player_id: int):
    game = games.get(game_id)
    if game is None or player_id < 0 or player_id >= len(game.state.players):
        await websocket.accept()
        await websocket.close(code=1008)
        return

    await manager.connect(game_id, player_id, websocket)

    # Send initial state
    await websocket.send_json(player_state_dict(game, player_id))

    try:
        while True:
            # We mostly use WebSocket for downstream updates.
            # Upstream can be HTTP or WS. For simplicity let's listen for ping or actions.
            await websocket.receive_text()
            # Handle incoming messages if needed
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(game_id, player_id, websocket)
