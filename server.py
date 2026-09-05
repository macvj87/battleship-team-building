"""
The web server.

It does four things:

    1. serves the four pages (join, play, admin, projector board)
    2. handles joining over plain HTTP, so errors are easy to show
    3. runs one WebSocket hub that pushes game state to every connected client
    4. ticks the clock a few times a second and lets the session act on timeouts

All the actual game rules live in game.py and session.py. This file only moves
messages around.
"""

import asyncio
import contextlib
import csv
import io
import json
import os
import socket
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import config
from game import RuleError
from session import Session
from store import Store

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

# The admin key keeps teams out of the admin panel. Set ADMIN_KEY in the
# environment to pin it, otherwise a fresh one is printed on every start.
ADMIN_KEY = os.environ.get("ADMIN_KEY") or "".join(
    __import__("secrets").choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6)
)

store = Store(os.path.join(HERE, config.DATABASE_FILE))
store.abandon_unfinished()          # tidy up anything a previous run left open
session = Session(store)


# -----------------------------------------------------------------------------
# WebSocket hub
# -----------------------------------------------------------------------------

class Client:
    """One open browser connection.

    A player client stores only their token, never a Player object. The admin
    can start a rematch, which builds fresh Player objects behind the same
    tokens, so we look the player up each time instead of holding a reference
    that would quietly go stale.
    """

    def __init__(self, ws: WebSocket, role: str, token: Optional[str] = None) -> None:
        self.ws = ws
        self.role = role          # "player" | "admin" | "board"
        self.token = token

    @property
    def player(self):
        return session.find_by_token(self.token) if self.token else None


class Hub:
    """Keeps track of who is connected and pushes each of them the right view."""

    def __init__(self) -> None:
        self.clients: List[Client] = []
        self._sent_upto = (0, 0)   # (game id, last event seq) already broadcast

    def add(self, client: Client) -> None:
        self.clients.append(client)
        if client.player:
            client.player.connected = True

    def remove(self, client: Client) -> None:
        if client in self.clients:
            self.clients.remove(client)
        player = client.player
        if player:
            # A team counts as connected while at least one of their tabs is open.
            player.connected = any(c.token == client.token for c in self.clients)

    def view_for(self, client: Client) -> dict:
        if client.role == "admin":
            return session.view_for_admin()
        if client.role == "board":
            return session.view_for_board()
        player = client.player
        if player and session.players.get(player.slot) is player:
            return session.view_for_player(player)
        # Their slot disappeared (kicked, or the game was reset without them).
        return {"role": "player", "phase": "evicted", "log": []}

    async def send(self, client: Client, message: dict) -> None:
        with contextlib.suppress(Exception):
            await client.ws.send_text(json.dumps(message))

    async def broadcast(self) -> None:
        """Push any brand-new events (for animations), then the full state."""
        new_events = self._drain_events()
        for client in list(self.clients):
            if new_events:
                await self.send(client, {"type": "events", "events": new_events})
            await self.send(client, {"type": "state", "state": self.view_for(client)})

    def _drain_events(self) -> List[dict]:
        game_id, last_seq = self._sent_upto
        if game_id != session.id:
            last_seq = 0                      # a new game restarts the sequence
        fresh = [e for e in session.log if e["seq"] > last_seq]
        self._sent_upto = (session.id, session.seq)
        return fresh

    async def broadcast_clock(self) -> None:
        remaining = session.remaining()
        message = {
            "type": "clock",
            "phase": session.phase,
            "paused": session.paused,
            "remaining": None if remaining is None else round(remaining, 1),
            "total": session.total_for_phase(),
        }
        for client in list(self.clients):
            await self.send(client, message)


hub = Hub()


async def clock_loop() -> None:
    """Server-owned clock. The browsers only display it, they never decide it."""
    last_clock_push = 0.0
    while True:
        await asyncio.sleep(0.25)
        try:
            if session.tick():
                await hub.broadcast()
            now = asyncio.get_event_loop().time()
            if now - last_clock_push >= 1.0:
                last_clock_push = now
                await hub.broadcast_clock()
        except Exception as exc:                      # never let the clock die
            print("clock error:", exc)


# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------

@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(clock_loop())
    print_banner()
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    store.close()


app = FastAPI(title="Battleship LAN", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

# The four pages, for the cache rule below.
PAGE_PATHS = {"/", "/play", "/admin", "/board"}


@app.middleware("http")
async def always_revalidate(request: Request, call_next):
    """Never let a browser reuse a page or asset without checking with us.

    Without this the responses carry no Cache-Control at all, so browsers fall
    back to heuristic caching and can serve a stale copy for hours without
    asking. During a match that means one team quietly playing an older build
    of the game than the other - different layout, missing features - which is
    very hard to spot from the outside.

    Everything here is a few kilobytes over a LAN, and the files already carry
    ETags, so revalidating each time costs a handful of 304s.
    """
    response = await call_next(request)
    path = request.url.path
    if path in PAGE_PATHS or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


def page(name: str) -> FileResponse:
    return FileResponse(os.path.join(STATIC, name))


@app.get("/")
def join_page():
    return page("join.html")


@app.get("/play")
def play_page():
    return page("play.html")


@app.get("/admin")
def admin_page():
    return page("admin.html")


@app.get("/board")
def board_page():
    return page("board.html")


# --- plain HTTP API ----------------------------------------------------------

# When the game is reached through a tunnel or a cloud host rather than the
# local network, set PUBLIC_URL so the admin panel shares the right link.
#   PUBLIC_URL=https://my-game.trycloudflare.com ./run.sh
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")


def lan_url() -> str:
    """The address teammates should open: the public URL if one is set,
    otherwise our best guess at this machine's address on the local network."""
    if PUBLIC_URL:
        return PUBLIC_URL

    ip = "127.0.0.1"
    with contextlib.suppress(Exception):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))   # no packets are sent; this just picks a route
        ip = probe.getsockname()[0]
        probe.close()
    return "http://%s:%d" % (ip, config.PORT)


@app.get("/api/info")
def api_info():
    return {
        "gridSize": config.GRID_SIZE,
        "fleet": [{"key": k, "name": n, "size": s} for k, n, s in config.FLEET],
        "lanUrl": lan_url(),
    }


@app.post("/api/join")
async def api_join(request: Request):
    body = await request.json()
    try:
        player = session.join(body.get("name", ""), body.get("token"))
    except RuleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await hub.broadcast()
    return {"token": player.token, "slot": player.slot, "name": player.name}


@app.get("/api/session")
def api_session(token: str = ""):
    """Used by the join page to send a returning team straight back into the game."""
    player = session.find_by_token(token)
    if not player:
        return {"valid": False}
    return {"valid": True, "slot": player.slot, "name": player.name, "phase": session.phase}


def require_admin(key: str) -> None:
    if key != ADMIN_KEY:
        raise HTTPException(status_code=403, detail="Bad admin key")


@app.get("/api/history")
def api_history(key: str = Query("")):
    require_admin(key)
    return {"games": store.history(), "standings": store.standings()}


@app.get("/api/replay/{game_id}")
def api_replay(game_id: int, key: str = Query("")):
    require_admin(key)
    events = store.events(game_id)
    if not events:
        raise HTTPException(status_code=404, detail="No such game")
    meta = next((g for g in store.history(500) if g["id"] == game_id), None)
    return {"gameId": game_id, "meta": meta, "events": events, "gridSize": config.GRID_SIZE}


@app.get("/api/export.csv")
def api_export(key: str = Query("")):
    require_admin(key)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Team", "Played", "Wins", "Losses", "Shots", "Hits", "Accuracy %"])
    for row in store.standings():
        writer.writerow([
            row["name"], row["played"], row["wins"], row["losses"],
            row["shots"], row["hits"], "%.1f" % row["accuracy"],
        ])
    writer.writerow([])
    writer.writerow(["Game", "Ended", "Winner", "Duration (s)", "Team 1", "Team 2"])
    for g in store.history():
        names = [p["name"] for p in g["players"]]
        writer.writerow([
            g["id"], g["endedAt"], g["winner"] or "-",
            "" if g["duration"] is None else "%.0f" % g["duration"],
            names[0] if len(names) > 0 else "", names[1] if len(names) > 1 else "",
        ])
    return PlainTextResponse(out.getvalue(), media_type="text/csv")


# --- WebSocket ---------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    client: Optional[Client] = None
    try:
        # The first message identifies the client.
        hello = json.loads(await ws.receive_text())
        role = hello.get("role")

        if role == "admin":
            if hello.get("key") != ADMIN_KEY:
                await ws.send_text(json.dumps({"type": "error", "message": "Bad admin key"}))
                await ws.close()
                return
            client = Client(ws, "admin")
        elif role == "board":
            client = Client(ws, "board")
        else:
            player = session.find_by_token(hello.get("token", ""))
            if not player:
                await ws.send_text(json.dumps({"type": "kicked", "message": "Session expired"}))
                await ws.close()
                return
            client = Client(ws, "player", player.token)

        hub.add(client)
        await hub.broadcast()

        while True:
            message = json.loads(await ws.receive_text())
            await handle(client, message)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print("websocket error:", exc)
    finally:
        if client:
            hub.remove(client)
            with contextlib.suppress(Exception):
                await hub.broadcast()


async def handle(client: Client, message: dict) -> None:
    """Apply one client message to the session, then tell everybody."""
    kind = message.get("type")

    try:
        if client.role == "player":
            player = client.player
            if not player or session.players.get(player.slot) is not player:
                return
            if kind == "place":
                session.place(player, message["ship"], message["row"], message["col"],
                              bool(message["horizontal"]))
            elif kind == "unplace":
                session.unplace(player, message["ship"])
            elif kind == "randomize":
                session.randomize(player)
            elif kind == "clear":
                session.clear(player)
            elif kind == "ready":
                session.set_ready(player, bool(message.get("ready", True)))
            elif kind == "fire":
                session.fire(player, message["row"], message["col"])
            else:
                return

        elif client.role == "admin":
            if kind == "timers":
                session.set_timers(message["placementSeconds"], message["turnSeconds"])
            elif kind == "pause":
                session.set_paused(bool(message.get("paused", True)))
            elif kind == "skip":
                session.skip_turn()
            elif kind == "start":
                session.begin_battle()
            elif kind == "end":
                session.force_end(message.get("winner"))
            elif kind == "kick":
                session.remove(int(message["slot"]))
            elif kind == "reset":
                session.reset(rematch=bool(message.get("rematch")))
            else:
                return
        else:
            return

    except (RuleError, KeyError, ValueError) as exc:
        await hub.send(client, {"type": "notice", "message": str(exc)})
        return

    await hub.broadcast()


# -----------------------------------------------------------------------------

def print_banner() -> None:
    url = lan_url()
    line = "=" * 58
    print("\n" + line)
    print("  BATTLESHIP  -  ready for battle")
    print(line)
    print("  Players join at :  %s" % url)
    print("  Admin panel     :  %s/admin?key=%s" % (url, ADMIN_KEY))
    print("  Projector view  :  %s/board" % url)
    print(line)
    print("  Admin key: %s   (set ADMIN_KEY=... to keep it fixed)" % ADMIN_KEY)
    if not PUBLIC_URL:
        print("  Behind a tunnel? Set PUBLIC_URL=https://... so this link is right.")
    print(line + "\n", flush=True)   # flush so the links appear even when piped


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")
