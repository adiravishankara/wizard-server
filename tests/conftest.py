import os
import socket
import tempfile
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient

# Never touch Firebase or the dev data file from tests, even if the shell has
# credentials exported: the store is chosen when app.main is imported.
for _var in ("FIREBASE_CREDENTIALS_B64", "FIREBASE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS"):
    os.environ.pop(_var, None)
os.environ["LEAGUE_STORE"] = "json"
os.environ["LEAGUE_DATA_FILE"] = os.path.join(tempfile.mkdtemp(prefix="wizard-test-"), "league.json")

from app.main import app  # noqa: E402
from app.services.connection_manager import manager  # noqa: E402
from app.services.game_store import games  # noqa: E402
from app.services.league_store import JsonBackend, store as league_store  # noqa: E402
from app.services.trick_hold import clear_all as clear_trick_holds  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_league_store(tmp_path):
    league_store.use_backend(JsonBackend(tmp_path / "league.json"))
    yield league_store


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
    clear_trick_holds()
    with TestClient(app) as test_client:
        yield test_client
    games.clear()
    manager.active_connections.clear()
    clear_trick_holds()


@pytest.fixture
def live_server():
    games.clear()
    manager.active_connections.clear()
    clear_trick_holds()
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
    clear_trick_holds()
