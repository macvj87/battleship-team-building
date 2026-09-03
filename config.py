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

# The classic fleet. (key, display name, length in cells)
FLEET = [
    ("carrier",     "Carrier",     5),
    ("battleship",  "Battleship",  4),
    ("cruiser",     "Cruiser",     3),
    ("submarine",   "Submarine",   3),
    ("destroyer",   "Destroyer",   2),
]

# --- Timers (seconds) --------------------------------------------------------

PLACEMENT_SECONDS = 180   # time to arrange your fleet before the battle starts
TURN_SECONDS = 45         # time to take a single shot

# When a team runs out of time on their turn, fire a random shot for them
# instead of skipping. Keeps the game moving and stops one team stalling.
AUTO_SHOOT_ON_TIMEOUT = True

# --- Storage -----------------------------------------------------------------

DATABASE_FILE = "battleship.db"
