/* The big-screen view. Fog of war on both sides, so nothing is spoiled for
 * the room: only hits, misses and ships that have already been sunk. */
import { $, el, key, makeClock, WARN_SECONDS } from './util.js';
import { connect } from './net.js';
import { BoardView, fromServer } from './boardview.js';
import { renderFeed } from './feed.js';
import { victoryOverlay } from './victory.js';
import { sfx } from './sfx.js';

const gameClock = makeClock('Time');
$('#clockHost').append(gameClock.node);

const boards = { 1: new BoardView($('#board1')), 2: new BoardView($('#board2')) };
let view = null;
let fresh = new Set();
let pendingSunk = null;
let overlayShown = false;

const net = connect({ role: 'board' });
net.on('clock', (m) => {
  gameClock.sync(m.remaining, m.total, m.paused);
  // The room is watching this screen, so warn for whoever is on the clock.
  const live = view && (view.phase === 'battle' || view.phase === 'placement');
  const running = m.remaining !== null && !m.paused;
  document.body.classList.toggle('urgent', !!live && running && m.remaining <= WARN_SECONDS);
  paintBanner();
});
gameClock.onWarning((secondsLeft) => {
  if (view && (view.phase === 'battle' || view.phase === 'placement')) sfx.tick(secondsLeft);
});
net.on('events', (m) => m.events.forEach((event) => {
  if (event.type !== 'shot') return;
  const p = event.payload;
  fresh.add(key(p.row, p.col));
  if (p.sunk) {
    sfx.sunk();
    // The ship belongs to whoever was being shot at.
    pendingSunk = { slot: p.slot === 1 ? 2 : 1, name: p.sunk, cell: [p.row, p.col] };
  } else if (p.result === 'hit') {
    sfx.hit();
  } else {
    sfx.miss();
  }
}));
// Show the firing team's crosshair on the board they are aiming at.
net.on('aim', (m) => {
  const board = boards[m.target];
  if (!board) return;
  if (!m.active) { board.hidePointer(); return; }
  const team = ((view && view.teams) || []).find((t) => t.slot === m.slot);
  board.showPointer(m.x, m.y, { slot: m.slot, label: team ? team.name : '' });
});

net.on('state', (state) => { view = state; render(); });

function render() {
  const ready = (view.teams || []).length === 2 && view.phase !== 'lobby';
  $('#waiting').classList.toggle('hidden', ready);
  $('#duel').classList.toggle('hidden', !ready);
  $('#waitingNote').textContent = (view.teams || []).length
    ? `${view.teams.map((t) => t.name).join(', ')} — waiting for one more team.`
    : 'Waiting for both teams to join.';

  gameClock.setLabel(view.phase === 'placement' ? 'Deploying' : view.paused ? 'Paused' : 'Turn');

  paintBanner();

  for (const slot of [1, 2]) {
    const team = (view.teams || []).find((t) => t.slot === slot);
    const board = (view.boards || {})[String(slot)];
    $(`#name${slot}`).textContent = team ? team.name : '—';
    $(`#head${slot}`).classList.toggle('active', view.turn === slot && view.phase === 'battle');
    $(`#stat${slot}`).textContent = team ? `${team.hits} hits · ${team.accuracy}% acc` : '';

    // one pip per ship: filled while afloat, red once sunk
    const hp = $(`#hp${slot}`);
    hp.textContent = '';
    for (const ship of (board?.ships || [])) hp.append(el('i', { class: ship.sunk ? 'gone' : '' }));

    boards[slot].render(fromServer(board, { fresh }));
  }

  if (view.phase !== 'battle' || view.paused) {
    boards[1].hidePointer();
    boards[2].hidePointer();
  }

  if (pendingSunk) {
    const board = (view.boards || {})[String(pendingSunk.slot)];
    const ship = ((board && board.ships) || []).find((s) => s.sunk && s.name === pendingSunk.name);
    boards[pendingSunk.slot].celebrateSunk((ship && ship.cells) || [pendingSunk.cell], pendingSunk.name);
    boards[pendingSunk.slot].shake(true);
    pendingSunk = null;
  }

  renderFeed($('#feed'), view.log, { limit: 25 });

  if (view.phase === 'finished' && !overlayShown) {
    overlayShown = true;
    sfx.win();
    $('#overlayHost').append(victoryOverlay(view));
  }
  if (view.phase !== 'finished') { overlayShown = false; $('#overlayHost').textContent = ''; }
  fresh = new Set();
}

/** Repainted on new state and on every clock tick. */
function paintBanner() {
  if (!view) return;
  const banner = $('#turnBanner');
  const active = (view.teams || []).find((t) => t.slot === view.turn);
  const urgent = document.body.classList.contains('urgent');
  banner.className = 'turn-banner'
    + (view.phase === 'battle' && !view.paused ? ' yours' : ' waiting')
    + (urgent ? ' urgent' : '');
  banner.textContent =
    view.phase === 'placement' ? (urgent ? 'Deploy now — time almost up' : 'Fleets deploying')
    : view.phase === 'finished' ? 'Battle over'
    : view.paused ? 'Paused'
    : active ? `${active.name} to fire${urgent ? ' — hurry!' : ''}` : 'Standing by';
}

const soundToggle = $('#soundToggle');
const paint = () => { soundToggle.textContent = sfx.enabled ? '🔊' : '🔈'; };
soundToggle.addEventListener('click', () => { sfx.toggle(); paint(); });
paint();
