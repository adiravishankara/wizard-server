import socket
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient

from app.main import app
from app.services.connection_manager import manager
from app.services.game_store import games


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _wait_for_port(port: int, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError(f"server did not start on {port}")


@pytest.fixture
def client():
    games.clear()
    manager.active_connections.clear()
    with TestClient(app) as test_client:
        yield test_client
    games.clear()
    manager.active_connections.clear()


@pytest.fixture
def live_server():
    games.clear()
    manager.active_connections.clear()
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    _wait_for_port(port)
    yield {"http": f"http://127.0.0.1:{port}", "ws": f"ws://127.0.0.1:{port}"}
    server.should_exit = True
    thread.join(timeout=5)
    games.clear()
    manager.active_connections.clear()
