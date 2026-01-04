from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import game

app = FastAPI(title="Wizard Game API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(game.router, prefix="/api/game", tags=["game"])

@app.get("/")
async def root():
    return {"message": "Welcome to the Wizard Game API"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
