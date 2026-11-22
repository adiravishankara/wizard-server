import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.routers import game, league
from app.services.league_store import StoreError, store as league_store

app = FastAPI(title="Wizard Game API")


@app.exception_handler(StoreError)
async def store_error_handler(_request: Request, exc: StoreError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(game.router, prefix="/api/game", tags=["game"])
app.include_router(league.router, prefix="/api/league", tags=["league"])

STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/health")
async def health():
    return {"status": "ok", "league_store": league_store.backend_name}


@app.get("/")
async def root():
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"message": "Welcome to the Wizard Game API"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
