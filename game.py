"""
The rules of Battleship, and nothing else.

There is no networking, no database and no async code in this file, which makes
it easy to read and easy to test on its own. Two classes do all the work:

    Ship   -- one vessel: where it sits and which of its cells are hit
    Fleet  -- one team's board: five ships plus the shots fired at them
"""

import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from config import FLEET, GRID_SIZE

Cell = Tuple[int, int]  # (row, col), both 0-based


class RuleError(Exception):
    """Raised when a player tries to do something the rules don't allow."""


def rotate(shape, quarter_turns: int) -> List[Cell]:
    """Turn a shape clockwise and pull it back to the top-left corner.

    A quarter turn clockwise sends (row, col) to (col, -row); normalising
    afterwards keeps every shape anchored at (0, 0) so a ship's position always
    means the same thing whichever way it is facing.

    A straight ship only has two distinct faces, so turns 0 and 2 come out
    identical - pressing rotate still flips it, which is what you expect.
    """
    cells = [(int(r), int(c)) for r, c in shape]
    for _ in range(quarter_turns % 4):
        cells = [(c, -r) for r, c in cells]
    top = min(r for r, _ in cells)
    left = min(c for _, c in cells)
    return [(r - top, c - left) for r, c in cells]


# -----------------------------------------------------------------------------
# Ship
# -----------------------------------------------------------------------------

@dataclass
class Ship:
    key: str
    name: str
    shape: List[Cell]                  # cells it covers, facing its base direction
    row: Optional[int] = None          # None means "not placed on the board yet"
    col: Optional[int] = None
    rotation: int = 0                  # quarter turns clockwise, 0-3
    hits: Set[Cell] = field(default_factory=set)

    @property
    def size(self) -> int:
        """How many cells the ship covers - not how long it is."""
        return len(self.shape)

    @property
    def placed(self) -> bool:
        return self.row is not None and self.col is not None

    @property
    def sunk(self) -> bool:
        return len(self.hits) >= self.size

    def offsets(self) -> List[Cell]:
        """The shape as it currently faces."""
        return rotate(self.shape, self.rotation)

    def extent(self) -> Tuple[int, int]:
        """(height, width) of the box the ship currently needs."""
        offs = self.offsets()
        return max(r for r, _ in offs) + 1, max(c for _, c in offs) + 1

    def cells(self) -> List[Cell]:
        """Every cell this ship occupies, or an empty list if unplaced."""
        if not self.placed:
            return []
        return [(self.row + dr, self.col + dc) for dr, dc in self.offsets()]

    def to_dict(self, reveal: bool = True) -> dict:
        """Serialise for sending to a browser.

        `reveal=False` hides the position, which is how we describe a ship to
        the team that is trying to sink it. The shape is not a secret - both
        teams know a Submarine is a T - so it always goes out, and the placing
        team needs it to preview a rotation before committing.
        """
        data = {
            "key": self.key,
            "name": self.name,
            "size": self.size,
            "shape": [list(cell) for cell in self.shape],
            "sunk": self.sunk,
        }
        if reveal:
            data.update({
                "row": self.row,
                "col": self.col,
                "rotation": self.rotation,
                "placed": self.placed,
                "cells": self.cells(),
                "hits": sorted(self.hits),
            })
        return data


# -----------------------------------------------------------------------------
# Fleet
# -----------------------------------------------------------------------------

class Fleet:
    """One team's board: their five ships and every shot fired at them."""

    def __init__(self) -> None:
        self.ships: List[Ship] = [Ship(key, name, list(shape)) for key, name, shape in FLEET]
        # Shots the *opponent* has fired at this board: {(row, col): "hit" | "miss"}
        self.incoming: Dict[Cell, str] = {}

    # --- lookups -------------------------------------------------------------

    def ship(self, key: str) -> Ship:
        for s in self.ships:
            if s.key == key:
                return s
        raise RuleError("No such ship: %s" % key)

    def occupied(self) -> Dict[Cell, Ship]:
        """Map of every occupied cell to the ship sitting there."""
        return {cell: s for s in self.ships for cell in s.cells()}

    @property
    def fully_placed(self) -> bool:
        return all(s.placed for s in self.ships)

    @property
    def all_sunk(self) -> bool:
        return all(s.sunk for s in self.ships)

    # --- placement -----------------------------------------------------------

    def place(self, key: str, row: int, col: int, rotation: int = 0) -> None:
        """Put a ship on the board, replacing its previous position."""
        ship = self.ship(key)
        rotation = int(rotation) % 4
        cells = [(row + dr, col + dc) for dr, dc in rotate(ship.shape, rotation)]

        # Every cell must be inside the grid.
        for r, c in cells:
            if not (0 <= r < GRID_SIZE and 0 <= c < GRID_SIZE):
                raise RuleError("%s doesn't fit on the board there" % ship.name)

        # ...and must not touch another ship (this ship's own cells don't count,
        # since we are about to move it).
        taken = {cell: s for cell, s in self.occupied().items() if s.key != key}
        for cell in cells:
            if cell in taken:
                raise RuleError("%s would overlap the %s" % (ship.name, taken[cell].name))

        ship.row, ship.col, ship.rotation = row, col, rotation

    def unplace(self, key: str) -> None:
        ship = self.ship(key)
        ship.row = ship.col = None

    def clear(self) -> None:
        for s in self.ships:
            s.row = s.col = None

    def randomize(self, rng: Optional[random.Random] = None) -> None:
        """Drop the whole fleet onto the board at random, without overlaps."""
        rng = rng or random
        for attempt in range(200):
            self.clear()
            try:
                for ship in self.ships:
                    self._place_randomly(ship, rng)
                return
            except RuleError:
                continue  # unlucky layout, start over
        raise RuleError("Could not find a random layout (this should never happen)")

    def fill_random(self, rng: Optional[random.Random] = None) -> None:
        """Place only the ships that don't have a position yet.

        Used when the placement clock runs out: whatever a team already
        arranged by hand is kept, and the sea decides the rest.
        """
        rng = rng or random
        missing = [s for s in self.ships if not s.placed]
        if not missing:
            return
        for attempt in range(200):
            try:
                for ship in missing:
                    self._place_randomly(ship, rng)
                return
            except RuleError:
                for ship in missing:      # unlucky, put them back in the box
                    ship.row = ship.col = None
        self.randomize(rng)               # last resort: lay out the whole fleet

    def _place_randomly(self, ship: Ship, rng: random.Random) -> None:
        for attempt in range(200):
            rotation = rng.randint(0, 3)
            offs = rotate(ship.shape, rotation)
            height = max(r for r, _ in offs) + 1
            width = max(c for _, c in offs) + 1
            row = rng.randint(0, GRID_SIZE - height)
            col = rng.randint(0, GRID_SIZE - width)
            try:
                self.place(ship.key, row, col, rotation)
                return
            except RuleError:
                continue
        raise RuleError("No room for the %s" % ship.name)

    # --- firing --------------------------------------------------------------

    def receive_shot(self, row: int, col: int) -> dict:
        """Resolve an opponent's shot at this board.

        Returns {"result": "hit"|"miss", "sunk": <ship name or None>}.
        """
        if not (0 <= row < GRID_SIZE and 0 <= col < GRID_SIZE):
            raise RuleError("That shot is off the board")
        if (row, col) in self.incoming:
            raise RuleError("You've already fired at that square")

        ship = self.occupied().get((row, col))
        if ship is None:
            self.incoming[(row, col)] = "miss"
            return {"result": "miss", "sunk": None}

        ship.hits.add((row, col))
        self.incoming[(row, col)] = "hit"
        return {"result": "hit", "sunk": ship.name if ship.sunk else None}

    def open_cells(self) -> List[Cell]:
        """Squares nobody has fired at yet - used for automatic timeout shots."""
        return [
            (r, c)
            for r in range(GRID_SIZE)
            for c in range(GRID_SIZE)
            if (r, c) not in self.incoming
        ]

    # --- serialisation -------------------------------------------------------

    def to_dict(self) -> dict:
        """Full detail: what the owning team and the admin see."""
        return {
            "ships": [s.to_dict(reveal=True) for s in self.ships],
            "incoming": {_cell_key(cell): result for cell, result in self.incoming.items()},
            "fullyPlaced": self.fully_placed,
        }

    def to_public_dict(self) -> dict:
        """Fog of war: hits and misses are visible, ship positions are not.

        A sunk ship *is* revealed, which is how the classic board game works -
        so the attacker can finally see the outline of what they destroyed.
        """
        revealed = [cell for s in self.ships if s.sunk for cell in s.cells()]
        return {
            "ships": [s.to_dict(reveal=s.sunk) for s in self.ships],
            "incoming": {_cell_key(cell): result for cell, result in self.incoming.items()},
            "sunkCells": [_cell_key(cell) for cell in revealed],
        }

    def save(self) -> list:
        """Compact form for the database, so a game can be replayed later.

        The size is recorded alongside the position: the fleet in config.py can
        change between matches, and a replay should show the ships as they
        actually were, not as they are today.
        """
        return [
            {"key": s.key, "size": s.size, "row": s.row, "col": s.col,
             "rotation": s.rotation, "cells": s.cells()}
            for s in self.ships
        ]


def _cell_key(cell: Cell) -> str:
    """(3, 4) -> "3,4" - JSON object keys have to be strings."""
    return "%d,%d" % cell


def label(row: int, col: int) -> str:
    """(0, 0) -> "A1", the way players say it out loud."""
    return "%s%d" % (chr(ord("A") + col), row + 1)
