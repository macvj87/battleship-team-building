/* The big-screen view. Fog of war on both sides, so nothing is spoiled for
 * the room: only hits, misses and ships that have already been sunk. */
import { $, el, key, makeClock } from './util.js';
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
let overlayShown = false;

const net = connect({ role: 'board' });
net.on('clock', (m) => gameClock.sync(m.remaining, m.total, m.paused));
net.on('events', (m) => m.events.forEach((event) => {
  if (event.type !== 'shot') return;
  fresh.add(key(event.payload.row, event.payload.col));
  if (event.payload.sunk) sfx.sunk();
  else if (event.payload.result === 'hit') sfx.hit();
  else sfx.miss();
}));
net.on('state', (state) => { view = state; render(); });

function render() {
  const ready = (view.teams || []).length === 2 && view.phase !== 'lobby';
  $('#waiting').classList.toggle('hidden', ready);
  $('#duel').classList.toggle('hidden', !ready);
  $('#waitingNote').textContent = (view.teams || []).length
    ? `${view.teams.map((t) => t.name).join(', ')} — waiting for one more team.`
    : 'Waiting for both teams to join.';

  gameClock.setLabel(view.phase === 'placement' ? 'Deploying' : view.paused ? 'Paused' : 'Turn');

  const banner = $('#turnBanner');
  const active = (view.teams || []).find((t) => t.slot === view.turn);
  banner.className = 'turn-banner' + (view.phase === 'battle' && !view.paused ? ' yours' : ' waiting');
  banner.textContent =
    view.phase === 'placement' ? 'Fleets deploying'
    : view.phase === 'finished' ? 'Battle over'
    : view.paused ? 'Paused'
    : active ? `${active.name} to fire` : 'Standing by';

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

  renderFeed($('#feed'), view.log, { limit: 25 });

  if (view.phase === 'finished' && !overlayShown) {
    overlayShown = true;
    sfx.win();
    $('#overlayHost').append(victoryOverlay(view));
  }
  if (view.phase !== 'finished') { overlayShown = false; $('#overlayHost').textContent = ''; }
  fresh = new Set();
}

const soundToggle = $('#soundToggle');
const paint = () => { soundToggle.textContent = sfx.enabled ? '🔊' : '🔈'; };
soundToggle.addEventListener('click', () => { sfx.toggle(); paint(); });
paint();
