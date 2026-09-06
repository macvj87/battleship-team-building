/* The admin console: watch both fleets live, run the match, and replay
 * any past game move by move. */
import { $, el, key, makeClock, timeAgo, clock, toast } from './util.js';
import { connect } from './net.js';
import { BoardView, fromServer } from './boardview.js';
import { renderFeed } from './feed.js';

// ---------------------------------------------------------------- admin key
const params = new URLSearchParams(location.search);
let adminKey = (params.get('key') || localStorage.getItem('battleship.adminKey') || '').toUpperCase();

if (adminKey) start(adminKey);

$('#gateForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#gateKey').value.trim().toUpperCase();
  if (value) start(value);
});

async function start(candidate) {
  const response = await fetch(`/api/history?key=${encodeURIComponent(candidate)}`);
  if (!response.ok) {
    $('#gateError').textContent = 'That key was not accepted.';
    return;
  }
  adminKey = candidate;
  localStorage.setItem('battleship.adminKey', adminKey);
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#csvLink').href = `/api/export.csv?key=${encodeURIComponent(adminKey)}`;
  boot();
}

// ---------------------------------------------------------------- live view
let view = null;
let net = null;
let fleetSizes = {};              // {carrier: 5, ...} straight from the server
let fleetReady = Promise.resolve();
const gameClock = makeClock('Time');

function boot() {
  $('#clockHost').append(gameClock.node);

  fleetReady = fetch('/api/info').then((r) => r.json()).then((info) => {
    $('#lanUrl').textContent = info.lanUrl;
    $('#projectorLink').href = `${info.lanUrl}/board`;
    fleetSizes = Object.fromEntries(info.fleet.map((s) => [s.key, s.size]));
  });

  net = connect({ role: 'admin', key: adminKey }, {
    onOpen()  { $('#connection').className = 'badge live'; $('#connection').innerHTML = '<i class="dot"></i> live'; },
    onClose() { $('#connection').className = 'badge warn'; $('#connection').innerHTML = '<i class="dot pulse"></i> reconnecting'; },
  });
  net.on('clock', (m) => gameClock.sync(m.remaining, m.total, m.paused));
  net.on('events', (m) => m.events.forEach((event) => {
    if (event.type === 'shot' && event.payload.sunk) {
      // The ship belongs to whoever was being shot at.
      pendingSunk = {
        slot: event.payload.slot === 1 ? 2 : 1,
        name: event.payload.sunk,
        cell: [event.payload.row, event.payload.col],
      };
    }
  }));
  net.on('aim', (m) => {
    const board = liveBoards[m.target];
    if (!board) return;
    if (!m.active) { board.hidePointer(); return; }
    const team = ((view && view.teams) || []).find((t) => t.slot === m.slot);
    board.showPointer(m.x, m.y, { slot: m.slot, label: team ? team.name : '' });
  });

  net.on('state', (state) => { view = state; renderLive(); });

  wireControls();
  loadHistory();
}

const liveBoards = {};   // slot -> BoardView
let pendingSunk = null;  // a ship just went down; mark it after the redraw

function renderLive() {
  $('#phaseBadge').textContent = view.paused ? 'paused' : view.phase;
  $('#phaseBadge').className = 'badge ' + (view.paused ? 'warn' : view.phase === 'battle' ? 'live' : '');

  // timer inputs (don't fight the admin while they are typing)
  const editable = view.phase === 'lobby' || view.phase === 'placement';
  for (const [id, value] of [['placementSeconds', view.placementSeconds], ['turnSeconds', view.turnSeconds]]) {
    const input = $('#' + id);
    if (document.activeElement !== input) input.value = value;
    input.disabled = !editable;
  }
  $('#applyTimers').disabled = !editable;
  $('#pauseBtn').textContent = view.paused ? 'Resume' : 'Pause';
  $('#pauseBtn').disabled = view.phase !== 'battle' && view.phase !== 'placement';
  $('#skipBtn').disabled = view.phase !== 'battle';
  $('#startBtn').disabled = view.phase !== 'placement';
  $('#endBtn').disabled = view.phase === 'finished' || view.phase === 'lobby';

  // teams
  const teamsHost = $('#teams');
  teamsHost.textContent = '';
  for (const slot of [1, 2]) {
    const team = (view.teams || []).find((t) => t.slot === slot);
    teamsHost.append(el('div', { class: `team-row slot-${slot}` }, [
      el('div', { class: 'swatch' }),
      el('div', { class: 'info' }, [
        el('strong', {}, team ? team.name : 'Empty slot'),
        el('span', {}, team
          ? `${team.connected ? 'online' : 'offline'} · ${team.ready ? 'ready' : 'not ready'} · ${team.hits}/${team.shots} hits`
          : 'waiting to join'),
      ]),
      team ? el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: () => { if (confirm(`Remove ${team.name} from the match?`)) net.send({ type: 'kick', slot }); },
      }, 'Kick') : null,
    ]));
  }

  // both boards, fully revealed - this is the admin's privilege
  const host = $('#adminBoards');
  if (!Object.keys(liveBoards).length || host.dataset.game !== String(view.gameId)) {
    host.textContent = '';
    host.dataset.game = String(view.gameId);
    for (const slot of [1, 2]) {
      const wrap = el('div', { class: 'panel' });
      const head = el('div', { class: 'panel-head' });
      head.append(el('div', { class: 'board-title' }, [
        el('span', {}, `Slot ${slot}`), el('span', { class: 'name', id: `liveName${slot}` }, '—'),
      ]));
      const body = el('div', { class: 'panel-body' });
      wrap.append(head, body);
      host.append(wrap);
      liveBoards[slot] = new BoardView(body);
    }
  }
  for (const slot of [1, 2]) {
    const team = (view.teams || []).find((t) => t.slot === slot);
    const label = $(`#liveName${slot}`);
    if (label) label.textContent = team ? team.name : '—';
    const board = (view.boards || {})[String(slot)];
    liveBoards[slot].render(fromServer(board));
  }

  if (view.phase !== 'battle' || view.paused) {
    for (const slot of [1, 2]) if (liveBoards[slot]) liveBoards[slot].hidePointer();
  }

  if (pendingSunk && liveBoards[pendingSunk.slot]) {
    const board = (view.boards || {})[String(pendingSunk.slot)];
    const ship = ((board && board.ships) || []).find((s) => s.sunk && s.name === pendingSunk.name);
    liveBoards[pendingSunk.slot].celebrateSunk((ship && ship.cells) || [pendingSunk.cell], pendingSunk.name);
    pendingSunk = null;
  }

  // Count from the running score - the log sent to clients is trimmed.
  const shots = (view.teams || []).reduce((total, team) => total + team.shots, 0);
  $('#moveCount').textContent = `${shots} shots this match`;
  renderFeed($('#feed'), view.log);

  if (view.phase === 'finished') loadHistory();
}

function wireControls() {
  $('#copyUrl').addEventListener('click', async () => {
    const url = $('#lanUrl').textContent;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { toast(url); }
  });
  $('#applyTimers').addEventListener('click', () => net.send({
    type: 'timers',
    placementSeconds: +$('#placementSeconds').value,
    turnSeconds: +$('#turnSeconds').value,
  }));
  $('#pauseBtn').addEventListener('click', () => net.send({ type: 'pause', paused: !view.paused }));
  $('#skipBtn').addEventListener('click', () => net.send({ type: 'skip' }));
  $('#startBtn').addEventListener('click', () => net.send({ type: 'start' }));
  $('#endBtn').addEventListener('click', () => {
    if (confirm('End the match now? Any unplayed turns are discarded.')) net.send({ type: 'end' });
  });
  $('#rematchBtn').addEventListener('click', () => {
    if (confirm('Start a rematch with the same two teams?')) net.send({ type: 'reset', rematch: true });
  });
  $('#resetBtn').addEventListener('click', () => {
    if (confirm('Start a brand new game? Both teams will have to join again.')) net.send({ type: 'reset' });
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#tabLive').classList.toggle('hidden', tab.dataset.tab !== 'live');
      $('#tabHistory').classList.toggle('hidden', tab.dataset.tab !== 'history');
      if (tab.dataset.tab === 'history') loadHistory();
    });
  }
}

// ---------------------------------------------------------------- history
async function loadHistory() {
  const data = await fetch(`/api/history?key=${encodeURIComponent(adminKey)}`).then((r) => r.json());

  const standings = $('#standings');
  standings.textContent = '';
  standings.append(el('thead', {}, el('tr', {}, [
    el('th', { class: 'rank' }, '#'), el('th', {}, 'Team'), el('th', {}, 'W'), el('th', {}, 'L'),
    el('th', {}, 'Played'), el('th', {}, 'Shots'), el('th', {}, 'Hits'), el('th', {}, 'Acc.'),
  ])));
  const sbody = el('tbody');
  if (!data.standings.length) {
    sbody.append(el('tr', {}, el('td', { colspan: '8', class: 'muted' }, 'No finished matches yet.')));
  }
  data.standings.forEach((row, i) => {
    sbody.append(el('tr', { class: i === 0 ? 'gold' : '' }, [
      el('td', { class: 'rank' }, String(i + 1)),
      el('td', {}, row.name),
      el('td', { class: 'num' }, String(row.wins)),
      el('td', { class: 'num' }, String(row.losses)),
      el('td', { class: 'num' }, String(row.played)),
      el('td', { class: 'num' }, String(row.shots)),
      el('td', { class: 'num' }, String(row.hits)),
      el('td', { class: 'num' }, `${row.accuracy.toFixed(1)}%`),
    ]));
  });
  standings.append(sbody);

  const games = $('#games');
  games.textContent = '';
  games.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'When'), el('th', {}, 'Teams'), el('th', {}, 'Winner'),
    el('th', {}, 'Length'), el('th', {}, ''),
  ])));
  const gbody = el('tbody');
  if (!data.games.length) {
    gbody.append(el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No past matches yet.')));
  }
  for (const game of data.games) {
    gbody.append(el('tr', {}, [
      el('td', { class: 'muted' }, timeAgo(game.endedAt || game.createdAt)),
      el('td', {}, game.players.map((p) => p.name).join('  vs  ') || '—'),
      el('td', {}, game.winner || (game.status === 'abandoned' ? 'abandoned' : '—')),
      el('td', { class: 'num' }, game.duration ? clock(game.duration) : '—'),
      el('td', {}, el('button', { class: 'btn btn-sm', onclick: () => openReplay(game.id) }, 'Playback')),
    ]));
  }
  games.append(gbody);
}

// ---------------------------------------------------------------- playback
/* A recorded game is rebuilt from its event log: take the two fleet layouts
 * from the `fleet_ready` events, then apply the shots one at a time. */
const replay = { events: [], shots: [], index: 0, fleets: {}, boards: {}, timer: null, names: {} };

async function openReplay(gameId) {
  await fleetReady;               // we need the ship sizes before drawing
  const data = await fetch(`/api/replay/${gameId}?key=${encodeURIComponent(adminKey)}`).then((r) => r.json());
  replay.events = data.events;
  replay.shots = data.events.filter((e) => e.type === 'shot');
  replay.fleets = {};
  replay.names = {};

  for (const event of data.events) {
    if (event.type === 'fleet_ready') {
      replay.fleets[event.payload.slot] = event.payload.fleet;
      replay.names[event.payload.slot] = event.payload.name;
    }
    if (event.type === 'team_joined') replay.names[event.payload.slot] = event.payload.name;
  }

  $('#replayPanel').classList.remove('hidden');
  $('#replayTitle').textContent = `Game #${gameId}`;
  $('#replayScrub').max = String(replay.shots.length);
  $('#replayScrub').value = '0';

  const host = $('#replayBoards');
  host.textContent = '';
  replay.boards = {};
  for (const slot of [1, 2]) {
    const panel = el('div', { class: 'panel' });
    const head = el('div', { class: 'panel-head' }, el('div', { class: 'board-title' }, [
      el('span', {}, 'Waters of'), el('span', { class: 'name' }, replay.names[slot] || `Slot ${slot}`),
    ]));
    const body = el('div', { class: 'panel-body' });
    panel.append(head, body);
    host.append(panel);
    replay.boards[slot] = new BoardView(body);
  }

  seek(0);
  $('#replayPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Ship layouts from a recording -> the cells they cover.
 *
 *  Recordings now store the cells outright, so a match replays with the ships
 *  exactly as they were even after the fleet in config.py changes shape.
 *  Older recordings only kept a position and an orientation, from when every
 *  ship was a straight line; those are rebuilt the old way. */
function fleetCells(layout) {
  return (layout || []).filter((s) => s.row !== null && s.row !== undefined).map((s) => {
    if (s.cells && s.cells.length) return { key: s.key, cells: s.cells };
    const size = s.size || fleetSizes[s.key] || 3;
    const cells = Array.from({ length: size }, (_, i) =>
      s.horizontal ? [s.row, s.col + i] : [s.row + i, s.col]);
    return { key: s.key, cells };
  });
}

function seek(index) {
  replay.index = Math.max(0, Math.min(replay.shots.length, index));
  $('#replayScrub').value = String(replay.index);
  $('#replayPos').textContent = `${replay.index} / ${replay.shots.length}`;

  const marks = { 1: {}, 2: {} };
  const hitsPerShip = { 1: {}, 2: {} };
  const ships = { 1: fleetCells(replay.fleets[1]), 2: fleetCells(replay.fleets[2]) };

  for (const event of replay.shots.slice(0, replay.index)) {
    const p = event.payload;
    const targetSlot = p.slot === 1 ? 2 : 1;
    marks[targetSlot][key(p.row, p.col)] = p.result;
    if (p.result === 'hit') {
      const ship = ships[targetSlot].find((s) => s.cells.some(([r, c]) => r === p.row && c === p.col));
      if (ship) hitsPerShip[targetSlot][ship.key] = (hitsPerShip[targetSlot][ship.key] || 0) + 1;
    }
  }

  const lastKey = replay.index > 0
    ? key(replay.shots[replay.index - 1].payload.row, replay.shots[replay.index - 1].payload.col)
    : null;

  for (const slot of [1, 2]) {
    replay.boards[slot].render({
      ships: ships[slot].map((s) => ({
        ...s,
        sunk: (hitsPerShip[slot][s.key] || 0) >= s.cells.length,
      })),
      marks: marks[slot],
      sunkCells: [],
      fresh: lastKey && replay.shots[replay.index - 1].payload.slot !== slot ? new Set([lastKey]) : new Set(),
    });
  }

  // the log up to this point, so the feed matches what's on the boards
  const upto = replay.index === 0
    ? replay.events.filter((e) => e.type !== 'shot' && e.type !== 'game_over')
    : replay.events.filter((e) => e.seq <= replay.shots[replay.index - 1].seq);
  renderFeed($('#replayFeed'), upto, { limit: 40 });
}

$('#replayScrub').addEventListener('input', (event) => { stopPlayback(); seek(+event.target.value); });
$('#replayBack').addEventListener('click', () => { stopPlayback(); seek(replay.index - 1); });
$('#replayNext').addEventListener('click', () => { stopPlayback(); seek(replay.index + 1); });
$('#replayClose').addEventListener('click', () => { stopPlayback(); $('#replayPanel').classList.add('hidden'); });
$('#replayPlay').addEventListener('click', () => {
  if (replay.timer) { stopPlayback(); return; }
  if (replay.index >= replay.shots.length) seek(0);
  $('#replayPlay').textContent = 'Pause';
  replay.timer = setInterval(() => {
    if (replay.index >= replay.shots.length) { stopPlayback(); return; }
    seek(replay.index + 1);
  }, 650);
});

function stopPlayback() {
  if (replay.timer) clearInterval(replay.timer);
  replay.timer = null;
  $('#replayPlay').textContent = 'Play';
}
