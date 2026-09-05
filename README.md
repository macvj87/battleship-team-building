# Battleship — LAN team-building game

Two teams, one 10×10 ocean, played in the browser over your office network.
One person runs the server and hosts the admin panel; each team joins from
their own laptop with a team name.

## Running it

**macOS / Linux**

```bash
./run.sh
```

**Windows** — double-click `run.bat`, or run it from Command Prompt or
PowerShell:

```
run.bat
```

Either way, the first run creates a Python virtual environment and installs the
two dependencies (FastAPI and uvicorn). Every run after that starts
immediately. On Windows you need Python 3.9 or newer from
[python.org](https://www.python.org/downloads/) — tick **"Add python.exe to
PATH"** during setup.

The terminal prints three links:

```
Players join at :  http://192.168.x.x:8000
Admin panel     :  http://192.168.x.x:8000/admin?key=ABC123
Projector view  :  http://192.168.x.x:8000/board
```

Share the first link with both teams. Keep the second to yourself — the admin
key is what stops players wandering into the control panel. The third is the
fog-of-war view to put on a TV or projector for everyone else watching.

To keep the same admin key between restarts:

```bash
ADMIN_KEY=CAPTAIN PORT=9000 ./run.sh
```

On Windows the same thing, from Command Prompt:

```
set ADMIN_KEY=CAPTAIN && set PORT=9000 && run.bat
```

...or from PowerShell:

```
$env:ADMIN_KEY="CAPTAIN"; $env:PORT="9000"; .\run.bat
```

Stop the server with `Ctrl-C`.

## How a match runs

1. **Lobby** — both teams open the join link and enter a team name.
2. **Placement** — each team arranges five ships against a countdown
   (3 minutes by default). Pick a ship, click a square to drop it, press `R`
   to rotate, or hit **Randomize**. Any team that runs out of time gets a
   random layout.
3. **Battle** — teams alternate shots, 45 seconds each by default. Running out
   of time fires a random shot for you, so the game never stalls.
4. **Winner screen** — first team to sink all five enemy ships wins, with
   shots, hits and accuracy for both sides.

In the last 10 seconds of a countdown the screen edge pulses red, the banner
turns into a warning and a beep sounds once per second (sharper for the final
three). A team only gets the alert when the clock is running against *them* —
whoever's turn it is, or anyone still deploying — so nobody is startled while
they are waiting on the other side. The projector view alerts for whoever is
on the clock.

Sound is on by default with a toggle in the header of every screen. Browsers
won't play audio until someone has interacted with the page, which is automatic
for the teams (they click to place ships and fire) but not for the projector
view — **click the projector page once after opening it** if you want it to
beep.
5. **Report** — the admin panel keeps every past match, with all-time
   standings and move-by-move playback.

Both timers can be changed from the admin panel before the battle starts, or
permanently in `config.py`.

## Admin panel

* **Live match** — both fleets fully revealed, plus a running move log.
* **Controls** — pause/resume, skip a turn, force the battle to start, end the
  match, start a rematch with the same teams, or reset to a fresh game.
* **History & standings** — every finished match, an all-time leaderboard by
  team name, a CSV export, and **Playback**: step or auto-play through any past
  game and watch the shots land.

## If teams can't reach the server

Some corporate wifi has *client isolation* switched on, which blocks
laptop-to-laptop traffic. Test with one colleague before the event. If the LAN
is blocked, there are three fallbacks, easiest first.

### 1. Phone hotspot (no changes, 2 minutes)

Turn on a personal hotspot, have the host machine and both team laptops join
it, then run `./run.sh` and share the link it prints. Hotspot clients can talk
to each other, so this sidesteps the office network entirely. Fine for four or
five devices; watch your data plan if you also open the projector view.

### 2. A tunnel — play over the internet, no redeploy

A tunnel gives your locally running server a public HTTPS address. The game
still runs on your laptop; teams reach it from anywhere.

```bash
brew install cloudflared
```

Run the game in one terminal and the tunnel in another:

```bash
cloudflared tunnel --url http://localhost:8000
```

It prints a `https://something.trycloudflare.com` address. Restart the game
with that address so the admin panel shares the right link:

```bash
PUBLIC_URL=https://something.trycloudflare.com ADMIN_KEY=CAPTAIN ./run.sh
```

`ngrok http 8000` does the same thing if you already have an ngrok account.

Two things to know. The address is public: anyone who has it can take one of
the two team slots, so only start the tunnel when you're about to play and stop
it (`Ctrl-C`) afterwards. And the free Cloudflare address changes every time
you start the tunnel, so generate it before you share it.

### 3. A cloud host, for a permanent link

If you want a URL that always works, deploy to a host that runs a real
long-lived process with WebSocket support — **Render**, **Railway** and
**Fly.io** all do, and all have a free or near-free tier. The app already reads
`$PORT` from the environment, so the start command is:

```
pip install fastapi "uvicorn[standard]" && python server.py
```

Set `ADMIN_KEY` in the host's environment variables so it survives restarts.
One caveat: most free tiers have an ephemeral filesystem, so `battleship.db`
(and with it the standings) is wiped on every redeploy — attach a persistent
volume if the history matters to you.

**Netlify and Vercel will not work.** They serve static files and short-lived
serverless functions; this game needs a process that stays alive holding the
match state with a WebSocket open to each team.

### One team's screen looks different to the other's

Their browser is holding an old copy of the game. The server tells browsers to
revalidate every page and asset on each load, so this should not happen — but a
laptop that cached a copy *before* that rule existed can still be sitting on it.
One hard refresh clears it for good: **Ctrl-Shift-R** on Windows, **Cmd-Shift-R**
on a Mac.

### Check the host machine's firewall first

Before blaming the network, make sure the host is allowed to accept incoming
connections.

* **macOS** prompts the first time the server starts — click **Allow**.
* **Windows** shows "Windows Defender Firewall has blocked some features of
  this app" the first time Python opens a port. Tick **Private networks** and
  click **Allow access**. If you dismissed it by accident the teams will just
  see the join page fail to load; re-allow it under Windows Security →
  Firewall & network protection → Allow an app through firewall.

Finally, if the LAN is the problem but the machines are in one room, a cheap
unmanaged switch and a few ethernet cables also works, and needs no internet.

## The code

| File | What it does |
| --- | --- |
| `config.py` | Every tunable setting: grid size, fleet, timers, port |
| `game.py` | The rules — ships, placement, firing. No I/O, easy to test |
| `session.py` | One match: phases, turns, timers, the event log |
| `store.py` | SQLite persistence — teams, games, players, events |
| `server.py` | HTTP routes, the WebSocket hub, the server-side clock |
| `static/` | The four pages, one stylesheet, and small ES modules |
| `run.sh` / `run.bat` | Launchers for macOS/Linux and for Windows |

Everything the browser loads is served from this folder — no CDN, no npm, no
build step — so it works on a network with no internet access.

Game history lives in `battleship.db`. Copy it to keep the standings, delete it
to start over.
