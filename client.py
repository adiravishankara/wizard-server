import asyncio
import json
import requests
import websockets
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.prompt import Prompt, IntPrompt
from rich import print as rprint
import sys

console = Console()

BASE_URL = "http://localhost:8000/api/game"
WS_URL = "ws://localhost:8000/api/game/ws"

class WizardClient:
    def __init__(self):
        self.game_id = None
        self.player_id = None
        self.state = None
        self.name = None
        self.is_prompting = False

    def join_lobby(self):
        self.name = Prompt.ask("Enter your name")
        gid = Prompt.ask("Enter Game ID to join (leave blank to create new)", default="")
        
        payload = {"name": self.name}
        if gid:
            payload["game_id"] = gid
            
        try:
            response = requests.post(f"{BASE_URL}/join", json=payload)
            data = response.json()
            if response.status_code == 200:
                self.game_id = data["game_id"]
                self.player_id = data["player_id"]
                rprint(f"[green]Joined game {self.game_id} as player {self.player_id}[/green]")
            else:
                rprint(f"[red]Error: {data['detail']}[/red]")
                sys.exit(1)
        except Exception as e:
            rprint(f"[red]Failed to connect to server: {e}[/red]")
            sys.exit(1)

    def render_state(self):
        if not self.state:
            return

        # Do not clear if we are in the middle of a prompt, it breaks the UI
        if not self.is_prompting:
            console.clear()
        
        # Header
        trump_info = f"Trump: [bold yellow]{self.state['trump_suit'] or 'None'}[/bold yellow]"
        rprint(Panel(f"Wizard - Round {self.state['current_round']} | {trump_info} | Phase: {self.state['phase']}\nGame ID: [bold]{self.game_id}[/bold]", title=f"Player: {self.name} (#{self.player_id})"))

        # Scores and Trick Wins
        table = Table(title="Players")
        table.add_column("Index")
        table.add_column("Name")
        table.add_column("Score")
        table.add_column("Bid")
        table.add_column("Wins")
        
        for i, name in enumerate(self.state["players"]):
            bid = self.state["bids"].get(str(i), "?")
            wins = self.state["trick_wins"][i]
            score = self.state["scores"][i]
            style = "bold cyan" if i == self.state["current_player"] else ""
            table.add_row(str(i), name, str(score), str(str(bid) if bid is not None else "?"), str(wins), style=style)
        
        console.print(table)

        # Current Trick
        if self.state["current_trick"]:
            trick_str = " | ".join([f"{self.state['players'][p]}: {c['suit'] or ''}{c['rank'] if c['type'] == 'regular' else c['type']}" for p, c in self.state["current_trick"]])
            rprint(Panel(trick_str, title="Current Trick", border_style="green"))
        else:
            rprint(Panel("Waiting for lead card...", title="Current Trick"))

        # Hand
        hand_str = []
        for i, c in enumerate(self.state["hand"]):
            card_repr = f"[{i}] {c['suit'] or ''}{c['rank'] if c['type'] == 'regular' else c['type']}"
            hand_str.append(card_repr)
        
        rprint(Panel("  ".join(hand_str), title="Your Hand", subtitle=f"Lead Suit: {self.state['lead_suit'] or 'None'}"))

    async def receive_loop(self, websocket):
        async for message in websocket:
            self.state = json.loads(message)
            self.render_state()

    async def input_loop(self):
        while True:
            if not self.state:
                await asyncio.sleep(0.5)
                continue

            phase = self.state["phase"]
            current_player = self.state["current_player"]

            if phase == "lobby":
                if self.player_id == 0:
                    if len(self.state["players"]) >= 3:
                        self.is_prompting = True
                        ans = await asyncio.to_thread(Prompt.ask, "Everyone joined? Start game?", choices=["y", "n"])
                        self.is_prompting = False
                        if ans == "y":
                            requests.post(f"{BASE_URL}/{self.game_id}/start")
                            # After starting, we wait for next phase
                            await asyncio.sleep(1) 
                    else:
                        # Just wait for more players
                        await asyncio.sleep(2)
                else:
                    await asyncio.sleep(2)

            elif phase == "waiting_trump":
                if current_player == self.player_id:
                    self.is_prompting = True
                    suit = await asyncio.to_thread(Prompt.ask, "Your turn! Choose trump suit", choices=["H", "D", "C", "S"])
                    self.is_prompting = False
                    requests.post(f"{BASE_URL}/{self.game_id}/action", json={
                        "player_id": self.player_id,
                        "action": "choose_trump",
                        "value": 0,
                        "suit": suit
                    })
                else:
                    await asyncio.sleep(1)

            elif phase == "bidding":
                if current_player == self.player_id and str(self.player_id) not in self.state["bids"]:
                    # Check if we already bid (bids can be redacted but we know if we bid)
                    self.is_prompting = True
                    bid = await asyncio.to_thread(IntPrompt.ask, f"Your turn! Enter bid (0-{self.state['current_round']})")
                    self.is_prompting = False
                    requests.post(f"{BASE_URL}/{self.game_id}/action", json={
                        "player_id": self.player_id,
                        "action": "bid",
                        "value": bid
                    })
                else:
                    await asyncio.sleep(1)

            elif phase == "playing":
                if current_player == self.player_id:
                    self.is_prompting = True
                    card_idx = await asyncio.to_thread(IntPrompt.ask, "Your turn! Choose card index to play")
                    self.is_prompting = False
                    res = requests.post(f"{BASE_URL}/{self.game_id}/action", json={
                        "player_id": self.player_id,
                        "action": "play",
                        "value": card_idx
                    })
                    if res.status_code != 200:
                        try:
                            detail = res.json().get("detail", "Invalid play!")
                        except Exception:
                            detail = "Invalid play!"
                        rprint(f"[red]{detail}[/red]")
                else:
                    await asyncio.sleep(1)

            elif phase == "game_over":
                rprint("[bold gold1]GAME OVER![/bold gold1]")
                break
            
            await asyncio.sleep(0.1)

    async def play_loop(self):
        async with websockets.connect(f"{WS_URL}/{self.game_id}/{self.player_id}") as websocket:
            # Run both loops concurrently
            await asyncio.gather(
                self.receive_loop(websocket),
                self.input_loop()
            )

    def start(self):
        self.join_lobby()
        try:
            asyncio.run(self.play_loop())
        except KeyboardInterrupt:
            rprint("\n[yellow]Exiting game...[/yellow]")
            sys.exit(0)

if __name__ == "__main__":
    client = WizardClient()
    client.start()
