"""
All tunable settings for the game live here.

Change a value, restart the server, and it takes effect. The two timers can
also be adjusted from the admin panel before a match starts.
"""

# --- Network -----------------------------------------------------------------

import os

HOST = "0.0.0.0"   # 0.0.0.0 means "listen on every network interface" (needed for LAN)

# Cloud hosts (Render, Railway, Fly...) tell you which port to use via $PORT.
# On your own machine it just stays 8000.
PORT = int(os.environ.get("PORT", 8000))

# --- Board -------------------------------------------------------------------

GRID_SIZE = 10     # a 10 x 10 board, columns A-J and rows 1-10

def line(length):
    """A straight ship lying west-east, `length` cells long."""
    return [(0, i) for i in range(length)]


# The fleet. (key, display name, shape)
#
# A shape is the list of cells a ship covers, as (row, col) offsets from its
# top-left corner. Anything that fits on the grid works, not just straight
# lines, and every ship can be turned through four quarter-turns.
#
# The classic fleet gives the Cruiser and the Submarine three cells each, which
# makes them impossible to tell apart once they are on the board. The Submarine
# here is a T - three across with a conning tower above the middle - so it is
# unmistakable at a glance, whatever it sits next to.
FLEET = [
    ("carrier",     "Carrier",     line(5)),
    ("battleship",  "Battleship",  line(4)),
    ("cruiser",     "Cruiser",     line(3)),
    ("submarine",   "Submarine",   [(1, 0), (1, 1), (1, 2), (0, 1)]),
    ("destroyer",   "Destroyer",   line(2)),
]

# --- Timers (seconds) --------------------------------------------------------

PLACEMENT_SECONDS = 180   # time to arrange your fleet before the battle starts
TURN_SECONDS = 45         # time to take a single shot

# When a team runs out of time on their turn, fire a random shot for them
# instead of skipping. Keeps the game moving and stops one team stalling.
AUTO_SHOOT_ON_TIMEOUT = True

# --- Storage -----------------------------------------------------------------

DATABASE_FILE = "battleship.db"
