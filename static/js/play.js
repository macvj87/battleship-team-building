/* The team's screen: lobby -> place your fleet -> fight -> winner screen.
 *
 * The server owns all the rules. This file only draws the current state and
 * sends what the team clicked. The one exception is the placement preview,
 * which is checked locally so the ghost ship can turn red instantly.
 */
import { $, el, key, makeClock, toast, WARN_SECONDS } from './util.js';
import { connect } from './net.js';
import { BoardView, fromServer } from './boardview.js';
import { renderFeed } from './feed.js';
import { victoryOverlay } from './victory.js';
import { sfx } from './sfx.js';

const TOKEN = localStorage.getItem('battleship.token');
if (!TOKEN) location.replace('/');

// ---------------------------------------------------------------- elements
const connection = $('#connection');
const versus = $('#versus');
const views = { lobby: $('#lobbyView'), placement: $('#placementView'), battle: $('#battleView') };
const turnBanner = $('#turnBanner');
const feedHost = $('#feed');
const overlayHost = $('#overlayHost');

const gameClock = makeClock('Time');
$('#clockHost').append(gameClock.node);

const placementBoard = new BoardView($('#placementBoard'));
const yourBoard = new BoardView($('#yourBoard'));
const enemyBoard = new BoardView($('#enemyBoard'));

// ---------------------------------------------------------------- state
let view = null;                 // latest server state
let selected = null;             // ship key being positioned
let horizontal = true;
let hover = null;                // [row, col] under the cursor
let freshCells = new Set();      // cells that should animate on the next render
let pendingSunk = null;          // a ship went down; celebrate it after the redraw
let lastTurn = null;
let overlayShown = false;

// ---------------------------------------------------------------- socket
const net = connect({ role: 'player', token: TOKEN }, {
  onOpen()  { connection.className = 'badge live'; connection.innerHTML = '<i class="dot"></i> live'; },
  onClose() { connection.className = 'badge warn'; connection.innerHTML = '<i class="dot pulse"></i> reconnecting'; },
});

net.on('kicked', () => { localStorage.removeItem('battleship.token'); location.replace('/'); });
net.on('clock', (m) => {
  gameClock.sync(m.remaining, m.total, m.paused);
  const running = m.remaining !== null && !m.paused;
  document.body.classList.toggle('urgent', running && m.remaining <= WARN_SECONDS && waitingOnUs());
  renderTurnBanner();
});

/** Is this clock counting down against *us*? Only then do we sound the alarm -
 *  there is no point startling a team that is waiting for the other side. */
function waitingOnUs() {
  if (!view) return false;
  if (view.phase === 'placement') {
    const you = view.teams.find((t) => t.slot === view.you);
    return !!you && !you.ready;          // still deploying
  }
  return view.phase === 'battle' && view.turn === view.you;
}

// One beep per second over the last few seconds, sharper for the final three.
gameClock.onWarning((secondsLeft) => {
  if (waitingOnUs()) sfx.tick(secondsLeft);
});
net.on('events', (m) => m.events.forEach(handleEvent));

// The other team's crosshair, drifting over your own fleet.
net.on('aim', (m) => {
  if (!view || m.target !== view.you) return;
  if (!m.active) { yourBoard.hidePointer(); return; }
  const them = (view.teams || []).find((t) => t.slot === m.slot);
  yourBoard.showPointer(m.x, m.y, { slot: m.slot, label: them ? them.name : 'Incoming' });
});
net.on('state', (state) => { view = state; render(); });

/** Events arrive just before the state that contains them - use them for
 *  sound and animation, then let render() draw the result. */
function handleEvent(event) {
  if (event.type !== 'shot') {
    if (event.type === 'game_over') {
      const won = event.payload.winner === view?.you;
      setTimeout(() => (won ? sfx.win() : sfx.lose()), 250);
    }
    return;
  }
  const p = event.payload;
  freshCells.add(key(p.row, p.col));
  if (p.sunk) {
    sfx.sunk();
    pendingSunk = { by: p.slot, name: p.sunk, cell: [p.row, p.col] };
  } else if (p.result === 'hit') {
    sfx.hit();
  } else {
    sfx.miss();
  }
  // Being shot at is worth a jolt; losing a whole ship is worth a bigger one.
  if (view && p.slot !== view.you && p.result === 'hit') yourBoard.shake(!!p.sunk);
}

// ---------------------------------------------------------------- render
function render() {
  if (!view) return;
  if (view.phase === 'evicted') {
    localStorage.removeItem('battleship.token');
    location.replace('/');
    return;
  }

  renderVersus();
  show(view.phase === 'lobby' ? 'lobby' : view.phase === 'placement' ? 'placement' : 'battle');
  gameClock.setLabel(view.phase === 'placement' ? 'To deploy' : view.paused ? 'Paused' : 'Your turn');

  if (view.phase === 'placement') {
    renderPlacement();
  } else {
    renderBattle();
    if (pendingSunk) { playSunk(pendingSunk); pendingSunk = null; }
  }

  renderFeed(feedHost, view.log);
  if (!waitingOnUs()) document.body.classList.remove('urgent');

  if (view.phase === 'finished' && !overlayShown) {
    overlayShown = true;
    overlayHost.append(victoryOverlay(view, { youSlot: view.you }));
  }
  if (view.phase !== 'finished') {
    overlayShown = false;
    overlayHost.textContent = '';
  }
  freshCells = new Set();
}

function show(name) {
  for (const [key_, node] of Object.entries(views)) node.classList.toggle('hidden', key_ !== name);
}

function renderVersus() {
  const you = (view.teams || []).find((t) => t.slot === view.you);
  const them = (view.teams || []).find((t) => t.slot !== view.you);
  versus.textContent = '';

  versus.append(
    side(you, 'left', view.turn === you?.slot),
    el('div', { class: 'middle' }, [
      el('div', { class: 'vs' }, 'VERSUS'),
      view.paused ? el('span', { class: 'badge warn', style: 'margin-top:8px' }, 'paused') : null,
    ]),
    side(them, 'right', them && view.turn === them.slot),
  );

  function side(team, position, active) {
    const initials = team ? team.name.slice(0, 2).toUpperCase() : '??';
    return el('div', { class: `side ${position}${active ? ' active' : ''}` }, [
      el('div', { class: 'avatar' }, initials),
      el('div', { class: 'who' }, [
        el('strong', {}, team ? team.name : 'Waiting…'),
        el('span', {}, team
          ? `${team.shots} shots · ${team.hits} hits · ${team.accuracy}%`
          : 'no team yet'),
      ]),
    ]);
  }
}

// ---- placement -------------------------------------------------------------

function renderPlacement() {
  const board = view.yourBoard;
  const ships = board.ships;
  const placedCount = ships.filter((s) => s.placed).length;
  const locked = (view.teams.find((t) => t.slot === view.you) || {}).ready;

  $('#placementStatus').textContent = locked ? 'Fleet locked in' : `${placedCount} / ${ships.length} placed`;
  $('#placementStatus').className = locked ? 'badge live' : 'badge';

  const readyBtn = $('#readyBtn');
  readyBtn.disabled = !locked && placedCount < ships.length;
  readyBtn.textContent = locked ? 'Edit fleet' : 'Lock in fleet';
  readyBtn.classList.toggle('btn-primary', !locked);

  for (const id of ['rotateBtn', 'randomBtn', 'clearBtn']) $('#' + id).disabled = locked;

  // ship tray
  const tray = $('#tray');
  tray.textContent = '';
  for (const ship of ships) {
    const pips = el('div', { class: 'pips' }, Array.from({ length: ship.size }, () => el('i', { class: 'pip' })));
    tray.append(el('div', {
      class: `tray-ship${selected === ship.key ? ' active' : ''}${ship.placed ? ' done' : ''}`,
      onclick: () => { if (!locked) { selected = selected === ship.key ? null : ship.key; render(); } },
    }, [
      pips,
      el('div', { class: 'meta' }, [el('strong', {}, ship.name), el('span', {}, `${ship.size} cells`)]),
      ship.placed ? el('span', { class: 'check' }, '✓') : null,
    ]));
  }

  placementBoard.render({
    ...fromServer(board),
    ships: board.ships.filter((s) => s.placed).map((s) => ({ ...s, selected: s.key === selected })),
    placing: !locked,
  });
  drawGhost();
}

function shipByKey(k) {
  return view.yourBoard.ships.find((s) => s.key === k);
}

function ghostCells(ship, row, col) {
  return horizontal
    ? Array.from({ length: ship.size }, (_, i) => [row, col + i])
    : Array.from({ length: ship.size }, (_, i) => [row + i, col]);
}

/** Same check the server makes, done locally so the preview is instant. */
function isValid(ship, cells) {
  const taken = new Set(
    view.yourBoard.ships
      .filter((s) => s.placed && s.key !== ship.key)
      .flatMap((s) => s.cells.map(([r, c]) => key(r, c))),
  );
  return cells.every(([r, c]) => r >= 0 && c >= 0 && r < 10 && c < 10 && !taken.has(key(r, c)));
}

function drawGhost() {
  if (!selected || !hover) { placementBoard.clearGhost(); return; }
  const ship = shipByKey(selected);
  const cells = ghostCells(ship, hover[0], hover[1]);
  placementBoard.showGhost(cells, isValid(ship, cells));
}

placementBoard.listen({
  onHover(row, col) {
    hover = row === null ? null : [row, col];
    drawGhost();
  },
  onClick(row, col) {
    if (!view || view.phase !== 'placement') return;
    if ((view.teams.find((t) => t.slot === view.you) || {}).ready) return;

    if (!selected) {
      // Clicking a ship already on the board picks it up for repositioning.
      const under = view.yourBoard.ships.find(
        (s) => s.placed && s.cells.some(([r, c]) => r === row && c === col),
      );
      if (under) { selected = under.key; hover = [row, col]; render(); }
      return;
    }
    const ship = shipByKey(selected);
    const cells = ghostCells(ship, row, col);
    if (!isValid(ship, cells)) { toast(`${ship.name} doesn't fit there`); return; }
    net.send({ type: 'place', ship: ship.key, row, col, horizontal });
    sfx.place();
    // Move on to the next ship that still needs a home.
    const remaining = view.yourBoard.ships.filter((s) => !s.placed && s.key !== ship.key);
    selected = remaining.length ? remaining[0].key : null;
  },
});

$('#rotateBtn').addEventListener('click', () => { horizontal = !horizontal; drawGhost(); });
$('#randomBtn').addEventListener('click', () => { selected = null; net.send({ type: 'randomize' }); sfx.place(); });
$('#clearBtn').addEventListener('click',  () => { selected = null; net.send({ type: 'clear' }); });
$('#readyBtn').addEventListener('click',  () => {
  const locked = (view.teams.find((t) => t.slot === view.you) || {}).ready;
  net.send({ type: 'ready', ready: !locked });
  selected = null;
});

document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'r') { horizontal = !horizontal; drawGhost(); }
});

// ---- battle ----------------------------------------------------------------

function renderBattle() {
  const you = view.teams.find((t) => t.slot === view.you);
  const them = view.teams.find((t) => t.slot !== view.you);
  $('#yourName').textContent = you ? you.name : '—';
  $('#enemyName').textContent = them ? them.name : '—';

  const myTurn = view.phase === 'battle' && view.turn === view.you && !view.paused;

  renderTurnBanner();
  if (view.turn !== lastTurn && myTurn) sfx.turn();
  lastTurn = view.turn;

  // Nobody is aiming at us unless it is their turn.
  if (view.phase !== 'battle' || myTurn || view.paused) yourBoard.hidePointer();

  renderFleetStatus($('#enemyFleet'), $('#enemyAfloat'), view.enemyBoard, 'left to sink');
  renderFleetStatus($('#yourFleet'), $('#yourAfloat'), view.yourBoard, 'still afloat');

  yourBoard.render({ ...fromServer(view.yourBoard, { fresh: freshCells }) });
  enemyBoard.render({ ...fromServer(view.enemyBoard, { fresh: freshCells }), aimable: myTurn });
}

/** Repainted both on new state and on every clock tick, so the warning
 *  appears the moment the countdown crosses the threshold. */
function renderTurnBanner() {
  if (!view) return;
  const them = view.teams.find((t) => t.slot !== view.you);
  const myTurn = view.phase === 'battle' && view.turn === view.you && !view.paused;
  const urgent = document.body.classList.contains('urgent');

  turnBanner.className = 'turn-banner '
    + (view.phase !== 'battle' ? '' : myTurn ? 'yours' : 'waiting')
    + (urgent && myTurn ? ' urgent' : '');
  turnBanner.textContent = view.phase === 'finished'
    ? 'Battle over'
    : view.paused ? 'Paused by the admin'
    : myTurn && urgent ? 'Hurry! A random shot is fired when time runs out'
    : myTurn ? 'Your turn — pick a target'
    : `Waiting for ${them ? them.name : 'the other team'}`;
}

/**
 * The roster beside each board: which ships are still out there and which are
 * on the bottom.
 *
 * Enemy ships report their name, size and sunk state even under fog of war -
 * only their *position* is hidden - so a team can see that, say, only the
 * Carrier and a Cruiser are left and hunt for a five-long gap accordingly.
 */
function renderFleetStatus(host, badge, board, suffix) {
  const ships = (board && board.ships) || [];
  host.textContent = '';

  for (const ship of ships) {
    host.append(el('div', {
      class: `fleet-chip${ship.sunk ? ' sunk' : ''}`,
      title: `${ship.name} — ${ship.size} cells${ship.sunk ? ' — sunk' : ''}`,
    }, [
      el('span', { class: 'pips' }, Array.from({ length: ship.size }, () => el('i'))),
      el('span', { class: 'nm' }, ship.name),
    ]));
  }

  const afloat = ships.filter((s) => !s.sunk).length;
  badge.textContent = ships.length ? `${afloat} of ${ships.length} ${suffix}` : '';
  badge.className = 'badge' + (afloat === 0 ? ' danger' : afloat <= 2 ? ' warn' : '');
}

/** Wreck shockwave and name plate on whichever board just lost a ship.
 *  The state has already been redrawn by this point, so a ship the enemy just
 *  lost is revealed and we can outline it properly. */
function playSunk({ by, name, cell }) {
  const theirs = by === view.you;                       // we did the sinking
  const board = theirs ? enemyBoard : yourBoard;
  const data = theirs ? view.enemyBoard : view.yourBoard;
  const ship = ((data && data.ships) || []).find((s) => s.sunk && s.name === name);
  board.celebrateSunk((ship && ship.cells) || [cell], name);
}

// ---- broadcasting where we are aiming --------------------------------------

let lastAimSent = 0;
let aimInside = false;              // is the cursor over the enemy grid?
let lastAim = { x: 0, y: 0 };

/** Send our position over the enemy grid as a 0..1 fraction of the board, so
 *  it lands in the same spot on a laptop, a phone and the projector. */
function sendAim(x, y, active = true) {
  if (!view || view.phase !== 'battle' || view.turn !== view.you || view.paused) return;
  const now = performance.now();
  if (active && now - lastAimSent < 45) return;   // ~20 updates a second is plenty
  lastAimSent = now;
  net.send({ type: 'aim', x, y, active });
}

function aimFrom(clientX, clientY) {
  // Measure against the padding box, because that is what a percentage `left`
  // resolves against on the receiving end. Using the border box instead puts
  // the crosshair a pixel off from where the hand actually is.
  const grid = enemyBoard.grid;
  const box = grid.getBoundingClientRect();
  const x = (clientX - box.left - grid.clientLeft) / grid.clientWidth;
  const y = (clientY - box.top - grid.clientTop) / grid.clientHeight;
  aimInside = true;
  lastAim = { x, y };
  sendAim(x, y);
}

// A hand held still over one square - which is exactly the tense moment worth
// watching - stops firing mousemove, so repeat the last position while the
// cursor is still over the board. Without this the crosshair vanishes just as
// the other team is deciding.
setInterval(() => {
  if (!aimInside) return;
  lastAimSent = 0;                  // heartbeats skip the throttle
  sendAim(lastAim.x, lastAim.y);
}, 900);

enemyBoard.grid.addEventListener('mousemove', (event) => aimFrom(event.clientX, event.clientY));
enemyBoard.grid.addEventListener('mouseleave', () => { aimInside = false; sendAim(0, 0, false); });
enemyBoard.grid.addEventListener('touchmove', (event) => {
  const touch = event.touches[0];
  if (touch) aimFrom(touch.clientX, touch.clientY);
}, { passive: true });
enemyBoard.grid.addEventListener('touchend', () => { aimInside = false; sendAim(0, 0, false); });

enemyBoard.listen({
  onClick(row, col) {
    if (!view || view.phase !== 'battle' || view.paused) return;
    if (view.turn !== view.you) { toast("It's not your turn"); return; }
    if (view.enemyBoard && view.enemyBoard.incoming[key(row, col)]) return;
    sfx.fire();
    net.send({ type: 'fire', row, col });
  },
});

// ---- sound toggle ----------------------------------------------------------

const soundToggle = $('#soundToggle');
function paintSound() { soundToggle.textContent = sfx.enabled ? '🔊' : '🔈'; }
soundToggle.addEventListener('click', () => { sfx.toggle(); paintSound(); });
paintSound();
