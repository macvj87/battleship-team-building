/* The team's screen: lobby -> place your fleet -> fight -> winner screen.
 *
 * The server owns all the rules. This file only draws the current state and
 * sends what the team clicked. The one exception is the placement preview,
 * which is checked locally so the ghost ship can turn red instantly.
 */
import { $, el, key, makeClock, toast } from './util.js';
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
let lastTurn = null;
let overlayShown = false;

// ---------------------------------------------------------------- socket
const net = connect({ role: 'player', token: TOKEN }, {
  onOpen()  { connection.className = 'badge live'; connection.innerHTML = '<i class="dot"></i> live'; },
  onClose() { connection.className = 'badge warn'; connection.innerHTML = '<i class="dot pulse"></i> reconnecting'; },
});

net.on('kicked', () => { localStorage.removeItem('battleship.token'); location.replace('/'); });
net.on('clock', (m) => gameClock.sync(m.remaining, m.total, m.paused));
net.on('events', (m) => m.events.forEach(handleEvent));
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
  if (p.sunk) sfx.sunk();
  else if (p.result === 'hit') sfx.hit();
  else sfx.miss();
  // Being shot at is worth a jolt.
  if (view && p.slot !== view.you && p.result === 'hit') yourBoard.shake();
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

  if (view.phase === 'placement') renderPlacement();
  else renderBattle();

  renderFeed(feedHost, view.log);

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

  turnBanner.className = 'turn-banner ' + (view.phase !== 'battle' ? '' : myTurn ? 'yours' : 'waiting');
  turnBanner.textContent = view.phase === 'finished'
    ? 'Battle over'
    : view.paused ? 'Paused by the admin'
    : myTurn ? 'Your turn — pick a target' : `Waiting for ${them ? them.name : 'the other team'}`;

  if (view.turn !== lastTurn && myTurn) sfx.turn();
  lastTurn = view.turn;

  yourBoard.render({ ...fromServer(view.yourBoard, { fresh: freshCells }) });
  enemyBoard.render({ ...fromServer(view.enemyBoard, { fresh: freshCells }), aimable: myTurn });
}

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
