/* Draws one 10x10 board.
 *
 * The grid is a CSS grid of plain cells. Ships are drawn on top as single
 * rounded hulls spanning several cells (rather than a row of separate blocks),
 * and hit/miss markers sit above those. Everything is positioned with explicit
 * grid-row / grid-column, so no pixel maths is needed anywhere.
 */
import { el, key } from './util.js';

export class BoardView {
  constructor(host, size = 10) {
    this.size = size;
    this.root = el('div', { class: 'board' });

    const cols = el('div', { class: 'col-labels' });
    const rows = el('div', { class: 'row-labels' });
    for (let i = 0; i < size; i++) {
      cols.append(el('span', {}, String.fromCharCode(65 + i)));
      rows.append(el('span', {}, String(i + 1)));
    }

    this.grid = el('div', { class: 'grid', style: `--n:${size}` });
    this.cells = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = el('div', { class: 'cell' });
        cell.style.gridRow = r + 1;
        cell.style.gridColumn = c + 1;
        cell.dataset.r = r;
        cell.dataset.c = c;
        this.cells.push(cell);
        this.grid.append(cell);
      }
    }

    this.root.append(el('div', { class: 'corner' }), cols, rows, this.grid);
    host.append(this.root);

    this.overlay = [];   // ship hulls and markers, rebuilt on every render
    this.ghost = null;
  }

  /** Fires (row, col) on click, and (row, col) or (null) on hover. */
  listen({ onClick, onHover } = {}) {
    this.grid.addEventListener('click', (event) => {
      const cell = event.target.closest('.cell');
      if (cell && onClick) onClick(+cell.dataset.r, +cell.dataset.c);
    });
    if (onHover) {
      this.grid.addEventListener('mousemove', (event) => {
        const cell = event.target.closest('.cell');
        onHover(cell ? +cell.dataset.r : null, cell ? +cell.dataset.c : null);
      });
      this.grid.addEventListener('mouseleave', () => onHover(null, null));
    }
  }

  /**
   * data = {
   *   ships:     [{ cells: [[r,c]...], sunk, key }]   hulls to draw (may be [])
   *   marks:     { "r,c": "hit" | "miss" }
   *   sunkCells: ["r,c", ...]     cells belonging to a sunk-but-hidden ship
   *   fresh:     Set of "r,c" that should animate in
   *   aimable:   boolean - enable crosshair + radar sweep
   *   placing:   boolean - enable the placement cursor
   * }
   */
  render(data = {}) {
    const { ships = [], marks = {}, sunkCells = [], fresh = new Set() } = data;

    this.overlay.forEach((node) => node.remove());
    this.overlay = [];

    for (const ship of ships) {
      if (!ship.cells || !ship.cells.length) continue;
      const hull = this._hull(ship);
      this.overlay.push(hull);
      this.grid.append(hull);
    }

    const sunkSet = new Set(sunkCells);
    for (const [at, result] of Object.entries(marks)) {
      const [r, c] = at.split(',').map(Number);
      const isSunk = result === 'hit' && sunkSet.has(at);
      const mark = el('div', { class: `mark ${isSunk ? 'sunk' : result}${fresh.has(at) ? ' fresh' : ''}` });
      mark.style.gridRow = r + 1;
      mark.style.gridColumn = c + 1;
      this.overlay.push(mark);
      this.grid.append(mark);
    }

    this.grid.classList.toggle('aimable', !!data.aimable);
    this.grid.classList.toggle('placing', !!data.placing);
    if (this.ghost) this.grid.append(this.ghost);   // keep the ghost on top
  }

  _hull(ship) {
    const rows = ship.cells.map((cell) => cell[0]);
    const cols = ship.cells.map((cell) => cell[1]);
    const hull = el('div', { class: `ship-piece${ship.sunk ? ' sunk' : ''}${ship.selected ? ' selected' : ''}` });
    hull.style.gridRow = `${Math.min(...rows) + 1} / span ${Math.max(...rows) - Math.min(...rows) + 1}`;
    hull.style.gridColumn = `${Math.min(...cols) + 1} / span ${Math.max(...cols) - Math.min(...cols) + 1}`;
    return hull;
  }

  /** Translucent preview of where a ship would land. */
  showGhost(cells, valid) {
    this.clearGhost();
    if (!cells || !cells.length) return;
    const rows = cells.map((cell) => cell[0]);
    const cols = cells.map((cell) => cell[1]);
    const inside = cells.every(([r, c]) => r >= 0 && c >= 0 && r < this.size && c < this.size);
    if (!inside) return;
    this.ghost = el('div', { class: `ship-piece ghost${valid ? '' : ' invalid'}` });
    this.ghost.style.gridRow = `${Math.min(...rows) + 1} / span ${rows.length ? Math.max(...rows) - Math.min(...rows) + 1 : 1}`;
    this.ghost.style.gridColumn = `${Math.min(...cols) + 1} / span ${cols.length ? Math.max(...cols) - Math.min(...cols) + 1 : 1}`;
    this.grid.append(this.ghost);
  }

  clearGhost() {
    if (this.ghost) { this.ghost.remove(); this.ghost = null; }
  }

  shake() {
    this.grid.classList.remove('shaking');
    void this.grid.offsetWidth;          // restart the animation
    this.grid.classList.add('shaking');
  }
}

/** Turn a server board payload into what BoardView.render() wants. */
export function fromServer(board, { fresh } = {}) {
  if (!board) return { ships: [], marks: {}, sunkCells: [], fresh: fresh || new Set() };
  const ships = (board.ships || [])
    .filter((s) => s.cells && s.cells.length)
    .map((s) => ({ key: s.key, cells: s.cells, sunk: s.sunk }));
  // Own board: sunk ships are already in `ships`. Enemy board: only cells.
  const sunkCells = board.sunkCells
    || (board.ships || []).filter((s) => s.sunk && s.cells).flatMap((s) => s.cells.map((c) => key(c[0], c[1])));
  return { ships, marks: board.incoming || {}, sunkCells, fresh: fresh || new Set() };
}
