/* The winner screen, shared by the play page and the projector view. */
import { el } from './util.js';

const TROPHY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v5a6 6 0 0 1-12 0z"/>
  <path d="M6 5H3v1a4 4 0 0 0 4 4"/><path d="M18 5h3v1a4 4 0 0 1-4 4"/>
  <path d="M12 14v4"/><path d="M8 21h8"/><path d="M10 18h4v3h-4z"/></svg>`;

// The team that lost gets an anchor rather than a trophy they didn't win.
const ANCHOR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.2"/>
  <path d="M12 7.2V21"/><path d="M7 10h10"/>
  <path d="M4 14a8 8 0 0 0 16 0"/><path d="M4 14H2.5"/><path d="M20 14h1.5"/></svg>`;

/**
 * What the losing team reads. This is a team-building afternoon, not a
 * post-mortem, so the screen leads with what they did rather than the loss -
 * and the closer the match, the more it says so.
 */
function consolation(you, them, winnerName) {
  const sank = you && typeof you.sunk === 'number' ? you.sunk : 0;

  let line;
  if (sank >= 4) line = `One ship short. ${winnerName} only just got there.`;
  else if (sank === 3) line = `Three of their five on the bottom — that was a real fight.`;
  else if (sank >= 1) line = `You sank ${sank} of their ships before the tide turned.`;
  else line = `${winnerName} never gave you an opening. Next one's yours.`;

  // A losing team that shot straighter deserves to be told.
  if (you && them && you.accuracy > them.accuracy) {
    line += ` And you out-shot them: ${you.accuracy}% to ${them.accuracy}%.`;
  }
  return line;
}

/**
 * The end-of-match screen.
 *
 * It can be dismissed - close button, Esc, or a click on the backdrop - so the
 * final boards underneath can be looked over. Callers keep their own "already
 * shown" flag, which is only reset when a new game starts, so a screen that
 * has been closed stays closed.
 */
export function victoryOverlay(view, { youSlot = null, onClose = null } = {}) {
  const winner = (view.teams || []).find((t) => t.slot === view.winner);
  const stats = view.stats || view.teams || [];
  const youWon = youSlot !== null && view.winner === youSlot;

  const you = stats.find((s) => s.slot === youSlot);
  const them = stats.find((s) => s.slot === view.winner);
  const youLost = youSlot !== null && winner && !youWon;

  let eyebrow = winner ? winner.name : 'Result';
  let headline = winner ? `${winner.name} wins` : 'Battle ended';
  let subtitle = winner ? 'Every enemy ship sent to the bottom.' : '';

  if (youWon) {
    headline = 'Victory';
  } else if (youLost) {
    eyebrow = `${winner.name} wins`;
    headline = 'Well fought';
    subtitle = consolation(you, them, winner.name);
  }

  if (view.endReason === 'ended_by_admin') {
    if (!winner) headline = 'Battle ended';
    subtitle = 'The match was called by the admin.';
  }

  const cards = stats.map((s) => el('div', { class: `panel card${s.slot === view.winner ? ' winner' : ''}` }, [
    el('h3', {}, s.name + (s.slot === view.winner ? '  🏆' : '')),
    el('div', { class: 'stat' }, [el('span', {}, 'Shots fired'), el('b', {}, String(s.shots))]),
    el('div', { class: 'stat' }, [el('span', {}, 'Hits'), el('b', {}, String(s.hits))]),
    el('div', { class: 'stat' }, [el('span', {}, 'Accuracy'), el('b', {}, `${s.accuracy}%`)]),
    el('div', { class: 'stat' }, [
      el('span', {}, 'Ships sunk'),
      el('b', {}, `${s.sunk ?? '-'} / ${s.fleetSize ?? 5}`),
    ]),
  ]));

  const crest = el('div', { class: `crest${youLost ? ' quiet' : ''}` });
  crest.innerHTML = youLost ? ANCHOR : TROPHY;

  const dismissButton = el('button', { class: 'btn dismiss' }, 'View the final boards');
  const closeButton = el('button', {
    class: 'overlay-close', 'aria-label': 'Close', title: 'Close (Esc)',
  }, '✕');

  const overlay = el('div', { class: 'overlay' }, [
    closeButton,
    el('div', { class: 'victory' }, [
      crest,
      el('div', { class: 'eyebrow' }, eyebrow),
      el('h1', {}, headline),
      el('p', { class: 'sub' }, subtitle),
      el('div', { class: 'scorecard' }, cards),
      dismissButton,
    ]),
  ]);

  function dismiss() {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    if (onClose) onClose();
  }
  function onKeyDown(event) {
    if (event.key === 'Escape') dismiss();
  }

  closeButton.addEventListener('click', dismiss);
  dismissButton.addEventListener('click', dismiss);
  // A click on the backdrop counts, but not one inside the card.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKeyDown);

  return overlay;
}
