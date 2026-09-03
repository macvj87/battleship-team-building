/* The winner screen, shared by the play page and the projector view. */
import { el } from './util.js';

const CREST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v5a6 6 0 0 1-12 0z"/>
  <path d="M6 5H3v1a4 4 0 0 0 4 4"/><path d="M18 5h3v1a4 4 0 0 1-4 4"/>
  <path d="M12 14v4"/><path d="M8 21h8"/><path d="M10 18h4v3h-4z"/></svg>`;

export function victoryOverlay(view, { youSlot = null } = {}) {
  const winner = (view.teams || []).find((t) => t.slot === view.winner);
  const stats = view.stats || view.teams || [];
  const youWon = youSlot !== null && view.winner === youSlot;

  let headline = winner ? `${winner.name} wins` : 'Battle ended';
  if (youSlot !== null) headline = youWon ? 'Victory' : (winner ? 'Defeated' : 'Battle ended');

  const subtitle = view.endReason === 'ended_by_admin'
    ? 'The match was ended by the admin.'
    : winner ? `Every enemy ship sent to the bottom.` : '';

  const cards = stats.map((s) => el('div', { class: `panel card${s.slot === view.winner ? ' winner' : ''}` }, [
    el('h3', {}, s.name + (s.slot === view.winner ? '  🏆' : '')),
    el('div', { class: 'stat' }, [el('span', {}, 'Shots fired'), el('b', {}, String(s.shots))]),
    el('div', { class: 'stat' }, [el('span', {}, 'Hits'), el('b', {}, String(s.hits))]),
    el('div', { class: 'stat' }, [el('span', {}, 'Accuracy'), el('b', {}, `${s.accuracy}%`)]),
    el('div', { class: 'stat' }, [el('span', {}, 'Ships sunk'), el('b', {}, `${s.sunk ?? '-'} / 5`)]),
  ]));

  const crest = el('div', { class: 'crest' });
  crest.innerHTML = CREST;

  return el('div', { class: 'overlay' }, [
    el('div', { class: 'victory' }, [
      crest,
      el('div', { class: 'eyebrow' }, winner ? `${winner.name}` : 'Result'),
      el('h1', {}, headline),
      el('p', { class: 'sub' }, subtitle),
      el('div', { class: 'scorecard' }, cards),
    ]),
  ]);
}
