"""
One match, from lobby to winner screen.

`Session` owns the live state of the game and is the only place that decides
what is allowed to happen next. The server (server.py) just forwards messages
into it and broadcasts the result.

Phases:

    lobby      waiting for both teams to join
    placement  both teams arrange their fleet, against a countdown
    battle     alternating shots, against a per-turn countdown
    finished   somebody won; the winner screen is showing

Every meaningful thing that happens is appended to an event log, which is
written to the database as it goes. That single log powers three features at
once: the admin's live move feed, the post-game report, and playback.
"""

import random
import secrets
import time
from typing import Dict, List, Optional

import config
from game import Fleet, RuleError, label
from store import Store


class Player:
    def __init__(self, slot: int, name: str, team_id: int) -> None:
        self.slot = slot
        self.name = name
        self.team_id = team_id
        self.token = secrets.token_urlsafe(12)  # identifies this team on reconnect
        self.fleet = Fleet()
        self.ready = False
        self.connected = False
        self.shots = 0
        self.hits = 0

    @property
    def accuracy(self) -> float:
        return (self.hits / self.shots * 100.0) if self.shots else 0.0


class Session:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.placement_seconds = config.PLACEMENT_SECONDS
        self.turn_seconds = config.TURN_SECONDS
        self._start_new_game()

    # -------------------------------------------------------------------------
    # Lifecycle
    # -------------------------------------------------------------------------

    def _start_new_game(self, keep: Optional[Dict[int, Player]] = None) -> None:
        self.id = self.store.create_game()
        self.phase = "lobby"
        self.players: Dict[int, Player] = {}
        self.turn: Optional[int] = None
        self.winner: Optional[int] = None
        self.end_reason: Optional[str] = None
        self.paused = False
        self.deadline: Optional[float] = None   # epoch seconds, or None
        self.frozen_remaining: Optional[float] = None  # set while paused
        self.seq = 0
        self.log: List[dict] = []
        self.record("game_created", {})

        # A rematch keeps the same two teams so nobody has to rejoin.
        if keep:
            for slot, old in keep.items():
                player = Player(slot, old.name, old.team_id)
                player.token = old.token          # their browser stays logged in
                player.connected = old.connected
                self.players[slot] = player
                self.store.add_player(self.id, player.team_id, slot)
                self.record("team_joined", {"slot": slot, "name": player.name})
            self._maybe_begin_placement()

    def reset(self, rematch: bool = False) -> None:
        """End the current game and open a fresh one."""
        if self.phase != "finished":
            self.store.set_status(self.id, "abandoned")
        keep = dict(self.players) if rematch else None
        self._start_new_game(keep)

    # -------------------------------------------------------------------------
    # Event log
    # -------------------------------------------------------------------------

    def record(self, type_: str, payload: dict) -> None:
        self.seq += 1
        event = {"seq": self.seq, "ts": time.time(), "type": type_, "payload": payload}
        self.log.append(event)
        self.store.add_event(self.id, event["seq"], event["ts"], type_, payload)

    # -------------------------------------------------------------------------
    # Joining
    # -------------------------------------------------------------------------

    def find_by_token(self, token: str) -> Optional[Player]:
        for player in self.players.values():
            if token and player.token == token:
                return player
        return None

    def join(self, name: str, token: Optional[str] = None) -> Player:
        """Claim a slot, or step back into the one you already had."""
        name = " ".join(name.split())[:24]
        if not name:
            raise RuleError("Please enter a team name")

        # Returning with a valid token: just reconnect, whatever the phase.
        existing = self.find_by_token(token or "")
        if existing:
            return existing

        # Same team name, browser lost its token (cleared storage, new laptop):
        # let them back in rather than locking them out mid-game.
        for player in self.players.values():
            if player.name.lower() == name.lower():
                if player.connected:
                    raise RuleError("That team name is already taken")
                return player

        if self.phase not in ("lobby", "placement"):
            raise RuleError("The battle has already started")

        slot = 1 if 1 not in self.players else (2 if 2 not in self.players else None)
        if slot is None:
            raise RuleError("Both team slots are full")

        player = Player(slot, name, self.store.team_id(name))
        self.players[slot] = player
        self.store.add_player(self.id, player.team_id, slot)
        self.record("team_joined", {"slot": slot, "name": name})
        self._maybe_begin_placement()
        return player

    def remove(self, slot: int) -> None:
        player = self.players.pop(slot, None)
        if not player:
            return
        self.store.remove_player(self.id, slot)
        self.record("team_left", {"slot": slot, "name": player.name})
        if self.phase in ("placement", "battle"):
            # Losing a team mid-match drops everyone back to the lobby.
            self.phase = "lobby"
            self.deadline = None
            self.turn = None
            for other in self.players.values():
                other.ready = False

    def _maybe_begin_placement(self) -> None:
        if self.phase == "lobby" and len(self.players) == 2:
            self.phase = "placement"
            self.deadline = time.time() + self.placement_seconds
            self.store.set_status(self.id, "placement")
            self.record("placement_started", {"seconds": self.placement_seconds})

    # -------------------------------------------------------------------------
    # Placement phase
    # -------------------------------------------------------------------------

    def _placing(self, player: Player) -> None:
        if self.phase != "placement":
            raise RuleError("You can't rearrange your fleet now")
        if player.ready:
            raise RuleError("Your fleet is locked in - press Edit to change it")

    def place(self, player: Player, key: str, row: int, col: int, rotation: int) -> None:
        self._placing(player)
        player.fleet.place(key, row, col, rotation)

    def unplace(self, player: Player, key: str) -> None:
        self._placing(player)
        player.fleet.unplace(key)

    def randomize(self, player: Player) -> None:
        self._placing(player)
        player.fleet.randomize()

    def clear(self, player: Player) -> None:
        self._placing(player)
        player.fleet.clear()

    def set_ready(self, player: Player, ready: bool) -> None:
        if self.phase != "placement":
            raise RuleError("Nothing to confirm right now")
        if ready and not player.fleet.fully_placed:
            raise RuleError("Place all five ships first")
        player.ready = ready
        if ready:
            self.record("fleet_ready", {
                "slot": player.slot, "name": player.name, "fleet": player.fleet.save(),
            })
        if all(p.ready for p in self.players.values()) and len(self.players) == 2:
            self.begin_battle()

    # -------------------------------------------------------------------------
    # Battle phase
    # -------------------------------------------------------------------------

    def begin_battle(self) -> None:
        """Lock in both fleets and start the shooting. A coin toss picks who goes first."""
        if self.phase not in ("placement",):
            raise RuleError("The battle can't start from here")
        if len(self.players) < 2:
            raise RuleError("Both teams need to join first")

        for player in self.players.values():
            # Keep whatever they arranged by hand, fill in any ship they
            # didn't get to before the clock ran out.
            player.fleet.fill_random()
            player.ready = True
            self.store.update_player(self.id, player.slot, player.fleet.save(), 0, 0)

        self.phase = "battle"
        self.turn = random.choice([1, 2])
        self.deadline = time.time() + self.turn_seconds
        self.store.mark_started(self.id)
        self.record("battle_started", {
            "first": self.turn,
            "name": self.players[self.turn].name,
            "turnSeconds": self.turn_seconds,
        })

    def fire(self, player: Player, row: int, col: int, auto: bool = False) -> dict:
        if self.phase != "battle":
            raise RuleError("There's no battle in progress")
        if self.paused:
            raise RuleError("The game is paused")
        if self.turn != player.slot:
            raise RuleError("It's not your turn")

        target = self.players[self._other(player.slot)]
        outcome = target.fleet.receive_shot(row, col)

        player.shots += 1
        if outcome["result"] == "hit":
            player.hits += 1
        self.store.update_player(
            self.id, player.slot, player.fleet.save(), player.shots, player.hits
        )

        self.record("shot", {
            "slot": player.slot,
            "name": player.name,
            "row": row,
            "col": col,
            "cell": label(row, col),
            "result": outcome["result"],
            "sunk": outcome["sunk"],
            "auto": auto,
        })

        if target.fleet.all_sunk:
            self._finish(player.slot, "fleet_destroyed")
        else:
            self._next_turn()
        return outcome

    def _next_turn(self) -> None:
        self.turn = self._other(self.turn)
        self.deadline = time.time() + self.turn_seconds

    @staticmethod
    def _other(slot: int) -> int:
        return 2 if slot == 1 else 1

    def _finish(self, winner_slot: Optional[int], reason: str) -> None:
        self.phase = "finished"
        self.winner = winner_slot
        self.end_reason = reason
        self.deadline = None
        winner = self.players.get(winner_slot) if winner_slot else None
        self.store.mark_finished(self.id, winner.team_id if winner else None)
        self.record("game_over", {
            "winner": winner_slot,
            "name": winner.name if winner else None,
            "reason": reason,
            "stats": self.stats(),
        })

    # -------------------------------------------------------------------------
    # Admin controls
    # -------------------------------------------------------------------------

    def set_timers(self, placement_seconds: int, turn_seconds: int) -> None:
        if self.phase not in ("lobby", "placement"):
            raise RuleError("Timers can only be changed before the battle")
        self.placement_seconds = max(30, min(1800, int(placement_seconds)))
        self.turn_seconds = max(10, min(600, int(turn_seconds)))
        if self.phase == "placement":
            self.deadline = time.time() + self.placement_seconds

    def set_paused(self, paused: bool) -> None:
        if paused == self.paused:
            return
        self.paused = paused
        if paused:
            self.frozen_remaining = self.remaining()
            self.deadline = None
            self.record("paused", {})
        else:
            if self.frozen_remaining is not None:
                self.deadline = time.time() + self.frozen_remaining
            self.frozen_remaining = None
            self.record("resumed", {})

    def skip_turn(self) -> None:
        if self.phase != "battle":
            raise RuleError("There's no turn to skip")
        self.record("turn_skipped", {"slot": self.turn, "name": self.players[self.turn].name})
        self._next_turn()

    def force_end(self, winner_slot: Optional[int] = None) -> None:
        if self.phase == "finished":
            return
        self._finish(winner_slot, "ended_by_admin")

    # -------------------------------------------------------------------------
    # Clock
    # -------------------------------------------------------------------------

    def remaining(self) -> Optional[float]:
        if self.paused:
            return self.frozen_remaining
        if self.deadline is None:
            return None
        return max(0.0, self.deadline - time.time())

    def total_for_phase(self) -> Optional[int]:
        if self.phase == "placement":
            return self.placement_seconds
        if self.phase == "battle":
            return self.turn_seconds
        return None

    def tick(self) -> bool:
        """Called a few times a second. Returns True if the clock changed the game."""
        if self.paused or self.deadline is None:
            return False
        if time.time() < self.deadline:
            return False

        if self.phase == "placement":
            self.record("placement_timeout", {})
            self.begin_battle()
            return True

        if self.phase == "battle":
            player = self.players[self.turn]
            self.record("turn_timeout", {"slot": player.slot, "name": player.name})
            if config.AUTO_SHOOT_ON_TIMEOUT:
                target = self.players[self._other(player.slot)]
                open_cells = target.fleet.open_cells()
                if open_cells:
                    row, col = random.choice(open_cells)
                    self.fire(player, row, col, auto=True)
                    return True
            self._next_turn()
            return True

        return False

    # -------------------------------------------------------------------------
    # Views - what each kind of client is allowed to see
    # -------------------------------------------------------------------------

    def _sunk_count(self, slot: int) -> int:
        """How many of that slot's ships are on the bottom (0 if they left)."""
        player = self.players.get(slot)
        return sum(1 for s in player.fleet.ships if s.sunk) if player else 0

    def stats(self) -> List[dict]:
        return [
            {
                "slot": p.slot,
                "name": p.name,
                "shots": p.shots,
                "hits": p.hits,
                "accuracy": round(p.accuracy, 1),
                "sunk": self._sunk_count(self._other(p.slot)),
                "fleetSize": len(config.FLEET),
            }
            for p in sorted(self.players.values(), key=lambda x: x.slot)
        ]

    def _base_view(self) -> dict:
        return {
            "gameId": self.id,
            "phase": self.phase,
            "paused": self.paused,
            "turn": self.turn,
            "winner": self.winner,
            "endReason": self.end_reason,
            "placementSeconds": self.placement_seconds,
            "turnSeconds": self.turn_seconds,
            "teams": [
                {
                    "slot": p.slot,
                    "name": p.name,
                    "ready": p.ready,
                    "connected": p.connected,
                    "shots": p.shots,
                    "hits": p.hits,
                    "accuracy": round(p.accuracy, 1),
                }
                for p in sorted(self.players.values(), key=lambda x: x.slot)
            ],
            "stats": self.stats() if self.phase == "finished" else None,
            "log": self.log[-60:],
        }

    def view_for_player(self, player: Player) -> dict:
        view = self._base_view()
        view["role"] = "player"
        view["you"] = player.slot
        view["yourBoard"] = player.fleet.to_dict()
        opponent = self.players.get(self._other(player.slot))
        view["enemyBoard"] = opponent.fleet.to_public_dict() if opponent else None
        return view

    def view_for_admin(self) -> dict:
        view = self._base_view()
        view["role"] = "admin"
        view["boards"] = {
            str(p.slot): p.fleet.to_dict() for p in self.players.values()
        }
        return view

    def view_for_board(self) -> dict:
        """The projector view: fog of war on both sides, so nothing is spoiled."""
        view = self._base_view()
        view["role"] = "board"
        view["boards"] = {
            str(p.slot): p.fleet.to_public_dict() for p in self.players.values()
        }
        return view
