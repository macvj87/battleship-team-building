/* Turns the server's event log into readable rows.
 * Used by the play page, the admin panel and the projector view. */
import { el } from './util.js';

const stamp = (ts) => new Date(ts * 1000).toLocaleTimeString(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** One event -> { who, what (DOM nodes or text), tone } or null to skip it. */
export function describe(event) {
  const p = event.payload || {};
  switch (event.type) {
    case 'team_joined':
      return { who: p.name, what: 'joined the battle', tone: 'info' };
    case 'team_left':
      return { who: p.name, what: 'left the battle', tone: 'info' };
    case 'placement_started':
      return { who: '—', what: 'Placement phase open', tone: 'info' };
    case 'placement_timeout':
      return { who: '—', what: 'Placement time expired', tone: 'info' };
    case 'fleet_ready':
      return { who: p.name, what: 'locked in their fleet', tone: 'info', slot: p.slot };
    case 'battle_started':
      return { who: '—', what: `Battle begins — ${p.name} fires first`, tone: 'info' };
    case 'shot': {
      const cell = el('span', { class: 'cell-ref' }, p.cell);
      let text;
      if (p.sunk) text = [cell, ` — SUNK the ${p.sunk}`];
      else if (p.result === 'hit') text = [cell, ' — direct hit'];
      else text = [cell, ' — miss'];
      if (p.auto) text.push(' (auto)');
      return { who: p.name, what: text, tone: p.sunk ? 'sunk' : p.result, slot: p.slot };
    }
    case 'turn_timeout':
      return { who: p.name, what: 'ran out of time', tone: 'info', slot: p.slot };
    case 'turn_skipped':
      return { who: p.name, what: 'turn skipped by admin', tone: 'info', slot: p.slot };
    case 'paused':
      return { who: '—', what: 'Game paused', tone: 'info' };
    case 'resumed':
      return { who: '—', what: 'Game resumed', tone: 'info' };
    case 'game_over':
      return { who: '—', what: p.name ? `${p.name} wins the battle` : 'Game ended', tone: 'sunk' };
    default:
      return null;                     // game_created and anything we don't show
  }
}

export function renderFeed(host, log, { newestFirst = true, limit = 60 } = {}) {
  host.textContent = '';
  const rows = (log || [])
    .map((event) => ({ event, line: describe(event) }))
    .filter((item) => item.line);
  if (newestFirst) rows.reverse();

  if (!rows.length) {
    host.append(el('div', { class: 'feed-row info' }, [el('span', {}, ''), el('span', {}, 'Nothing has happened yet.')]));
    return;
  }

  for (const { event, line } of rows.slice(0, limit)) {
    host.append(el('div', { class: `feed-row ${line.tone}${line.slot ? ' slot-' + line.slot : ''}` }, [
      el('span', { class: 'mono muted', style: 'font-size:10px' }, stamp(event.ts)),
      el('span', { class: 'what' }, [el('span', { class: 'who' }, line.who + '  '), ...[].concat(line.what)]),
      el('span', {}, ''),
    ]));
  }
}
