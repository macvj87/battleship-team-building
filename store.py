"""
Everything that gets written to disk, in one place.

We use SQLite through Python's built-in `sqlite3` module, so there is no
database server to install and no extra dependency. The whole history lives in
a single file (`battleship.db`) that you can copy to keep, or delete to start
fresh.

Four tables:

    teams    one row per team name, ever - this is what makes an all-time
             leaderboard possible across many matches
    games    one row per match
    players  which team took which slot in which game, and their final fleet
    events   the move log: every meaningful thing that happened, in order.
             Replaying these rows is what drives the admin playback feature.
"""

import json
import os
import sqlite3
import time
from typing import List, Optional

from config import DATABASE_FILE

SCHEMA = """
CREATE TABLE IF NOT EXISTS teams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     REAL NOT NULL,
    started_at     REAL,
    ended_at       REAL,
    status         TEXT NOT NULL,      -- lobby | placement | battle | finished | abandoned
    winner_team_id INTEGER,
    FOREIGN KEY (winner_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS players (
    game_id   INTEGER NOT NULL,
    team_id   INTEGER NOT NULL,
    slot      INTEGER NOT NULL,        -- 1 or 2
    fleet     TEXT,                    -- JSON: final ship positions
    shots     INTEGER NOT NULL DEFAULT 0,
    hits      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, slot),
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS events (
    game_id  INTEGER NOT NULL,
    seq      INTEGER NOT NULL,         -- 1, 2, 3... order within the game
    ts       REAL NOT NULL,
    type     TEXT NOT NULL,
    payload  TEXT NOT NULL,            -- JSON
    PRIMARY KEY (game_id, seq)
);
"""


class Store:
    def __init__(self, path: str = DATABASE_FILE) -> None:
        self.path = path
        # check_same_thread=False because uvicorn may touch this from more than
        # one thread; every call below is short and we never share a cursor.
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # --- teams ---------------------------------------------------------------

    def team_id(self, name: str) -> int:
        """Find a team by name, creating it the first time we see it."""
        row = self.db.execute(
            "SELECT id FROM teams WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row:
            return row["id"]
        cur = self.db.execute(
            "INSERT INTO teams (name, created_at) VALUES (?, ?)", (name, time.time())
        )
        self.db.commit()
        return cur.lastrowid

    # --- games ---------------------------------------------------------------

    def create_game(self) -> int:
        cur = self.db.execute(
            "INSERT INTO games (created_at, status) VALUES (?, 'lobby')", (time.time(),)
        )
        self.db.commit()
        return cur.lastrowid

    def set_status(self, game_id: int, status: str) -> None:
        self.db.execute("UPDATE games SET status = ? WHERE id = ?", (status, game_id))
        self.db.commit()

    def mark_started(self, game_id: int) -> None:
        self.db.execute(
            "UPDATE games SET started_at = ?, status = 'battle' WHERE id = ?",
            (time.time(), game_id),
        )
        self.db.commit()

    def mark_finished(self, game_id: int, winner_team_id: Optional[int]) -> None:
        self.db.execute(
            "UPDATE games SET ended_at = ?, status = 'finished', winner_team_id = ? WHERE id = ?",
            (time.time(), winner_team_id, game_id),
        )
        self.db.commit()

    def abandon_unfinished(self) -> None:
        """Tidy up games left open by a server crash or restart."""
        self.db.execute(
            "UPDATE games SET status = 'abandoned' WHERE status IN ('lobby','placement','battle')"
        )
        self.db.commit()

    # --- players -------------------------------------------------------------

    def add_player(self, game_id: int, team_id: int, slot: int) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO players (game_id, team_id, slot) VALUES (?, ?, ?)",
            (game_id, team_id, slot),
        )
        self.db.commit()

    def remove_player(self, game_id: int, slot: int) -> None:
        self.db.execute(
            "DELETE FROM players WHERE game_id = ? AND slot = ?", (game_id, slot)
        )
        self.db.commit()

    def update_player(self, game_id: int, slot: int, fleet: list, shots: int, hits: int) -> None:
        self.db.execute(
            "UPDATE players SET fleet = ?, shots = ?, hits = ? WHERE game_id = ? AND slot = ?",
            (json.dumps(fleet), shots, hits, game_id, slot),
        )
        self.db.commit()

    # --- events --------------------------------------------------------------

    def add_event(self, game_id: int, seq: int, ts: float, type_: str, payload: dict) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO events (game_id, seq, ts, type, payload) VALUES (?,?,?,?,?)",
            (game_id, seq, ts, type_, json.dumps(payload)),
        )
        self.db.commit()

    def events(self, game_id: int) -> List[dict]:
        rows = self.db.execute(
            "SELECT seq, ts, type, payload FROM events WHERE game_id = ? ORDER BY seq", (game_id,)
        ).fetchall()
        return [
            {"seq": r["seq"], "ts": r["ts"], "type": r["type"], "payload": json.loads(r["payload"])}
            for r in rows
        ]

    # --- reporting -----------------------------------------------------------

    def history(self, limit: int = 100) -> List[dict]:
        """Recent games, newest first, with both team names attached."""
        rows = self.db.execute(
            """
            SELECT g.id, g.created_at, g.started_at, g.ended_at, g.status,
                   g.winner_team_id, w.name AS winner_name
            FROM games g
            LEFT JOIN teams w ON w.id = g.winner_team_id
            WHERE g.status IN ('finished', 'abandoned')
            ORDER BY g.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        games = []
        for r in rows:
            players = self.db.execute(
                """
                SELECT p.slot, p.shots, p.hits, t.name
                FROM players p JOIN teams t ON t.id = p.team_id
                WHERE p.game_id = ? ORDER BY p.slot
                """,
                (r["id"],),
            ).fetchall()
            duration = None
            if r["started_at"] and r["ended_at"]:
                duration = r["ended_at"] - r["started_at"]
            games.append({
                "id": r["id"],
                "createdAt": r["created_at"],
                "endedAt": r["ended_at"],
                "status": r["status"],
                "winner": r["winner_name"],
                "duration": duration,
                "players": [
                    {"slot": p["slot"], "name": p["name"], "shots": p["shots"], "hits": p["hits"]}
                    for p in players
                ],
            })
        return games

    def standings(self) -> List[dict]:
        """All-time leaderboard, one row per team name."""
        rows = self.db.execute(
            """
            SELECT t.name,
                   COUNT(p.game_id)                                    AS played,
                   SUM(CASE WHEN g.winner_team_id = t.id THEN 1 ELSE 0 END) AS wins,
                   SUM(p.shots)                                        AS shots,
                   SUM(p.hits)                                         AS hits
            FROM teams t
            JOIN players p ON p.team_id = t.id
            JOIN games g   ON g.id = p.game_id AND g.status = 'finished'
            GROUP BY t.id
            ORDER BY wins DESC, hits DESC, t.name ASC
            """
        ).fetchall()
        table = []
        for r in rows:
            shots = r["shots"] or 0
            hits = r["hits"] or 0
            table.append({
                "name": r["name"],
                "played": r["played"],
                "wins": r["wins"] or 0,
                "losses": r["played"] - (r["wins"] or 0),
                "shots": shots,
                "hits": hits,
                "accuracy": (hits / shots * 100.0) if shots else 0.0,
            })
        return table
