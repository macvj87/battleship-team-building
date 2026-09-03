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


# -----------------------------------------------------------------------------
# Ship
# -----------------------------------------------------------------------------

@dataclass
class Ship:
    key: str
    name: str
    size: int
    row: Optional[int] = None          # None means "not placed on the board yet"
    col: Optional[int] = None
    horizontal: bool = True
    hits: Set[Cell] = field(default_factory=set)

    @property
    def placed(self) -> bool:
        return self.row is not None and self.col is not None

    @property
    def sunk(self) -> bool:
        return len(self.hits) >= self.size

    def cells(self) -> List[Cell]:
        """Every cell this ship occupies, or an empty list if unplaced."""
        if not self.placed:
            return []
        if self.horizontal:
            return [(self.row, self.col + i) for i in range(self.size)]
        return [(self.row + i, self.col) for i in range(self.size)]

    def to_dict(self, reveal: bool = True) -> dict:
        """Serialise for sending to a browser.

        `reveal=False` hides the position, which is how we describe a ship to
        the team that is trying to sink it.
        """
        data = {"key": self.key, "name": self.name, "size": self.size, "sunk": self.sunk}
        if reveal:
            data.update({
                "row": self.row,
                "col": self.col,
                "horizontal": self.horizontal,
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
        self.ships: List[Ship] = [Ship(key, name, size) for key, name, size in FLEET]
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

    def place(self, key: str, row: int, col: int, horizontal: bool) -> None:
        """Put a ship on the board, replacing its previous position."""
        ship = self.ship(key)
        cells = self._cells_for(ship.size, row, col, horizontal)

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

        ship.row, ship.col, ship.horizontal = row, col, horizontal

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
            horizontal = rng.random() < 0.5
            max_row = GRID_SIZE - (1 if horizontal else ship.size)
            max_col = GRID_SIZE - (ship.size if horizontal else 1)
            row = rng.randint(0, max_row)
            col = rng.randint(0, max_col)
            try:
                self.place(ship.key, row, col, horizontal)
                return
            except RuleError:
                continue
        raise RuleError("No room for the %s" % ship.name)

    @staticmethod
    def _cells_for(size: int, row: int, col: int, horizontal: bool) -> List[Cell]:
        if horizontal:
            return [(row, col + i) for i in range(size)]
        return [(row + i, col) for i in range(size)]

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

        A sunk ship *is* revealed, which is how the classic board game works.
        """
        revealed = [cell for s in self.ships if s.sunk for cell in s.cells()]
        return {
            "ships": [s.to_dict(reveal=False) for s in self.ships],
            "incoming": {_cell_key(cell): result for cell, result in self.incoming.items()},
            "sunkCells": [_cell_key(cell) for cell in revealed],
        }

    def save(self) -> list:
        """Compact form for the database, so a game can be replayed later."""
        return [
            {"key": s.key, "row": s.row, "col": s.col, "horizontal": s.horizontal}
            for s in self.ships
        ]


def _cell_key(cell: Cell) -> str:
    """(3, 4) -> "3,4" - JSON object keys have to be strings."""
    return "%d,%d" % cell


def label(row: int, col: int) -> str:
    """(0, 0) -> "A1", the way players say it out loud."""
    return "%s%d" % (chr(ord("A") + col), row + 1)
