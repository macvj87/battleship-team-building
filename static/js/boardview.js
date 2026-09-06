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
    this.pointer = null;      // the opposing team's crosshair
    this.pointerTimer = null;
  }

  /**
   * Show where the other team is aiming, as a fraction of the board
   * (0..1 on each axis) rather than pixels, so it lands in the same place on
   * a laptop and on a projector.
   *
   * The position is CSS-transitioned between updates, which turns a stream of
   * samples into smooth movement without sending more of them.
   */
  showPointer(x, y, { slot = 1, label = '' } = {}) {
    if (!this.pointer) {
      this.pointer = el('div', { class: 'aim-pointer' }, [
        el('span', { class: 'ring' }),
        el('span', { class: 'tag' }, label),
      ]);
      this.grid.append(this.pointer);
    }
    this.pointer.className = `aim-pointer slot-${slot}`;
    this.pointer.querySelector('.tag').textContent = label;
    this.pointer.style.left = `${x * 100}%`;
    this.pointer.style.top = `${y * 100}%`;

    // If the other end goes quiet - tab closed, network dropped - don't leave
    // a crosshair stranded on the board.
    clearTimeout(this.pointerTimer);
    this.pointerTimer = setTimeout(() => this.hidePointer(), 2500);
  }

  hidePointer() {
    clearTimeout(this.pointerTimer);
    if (!this.pointer) return;
    const node = this.pointer;
    this.pointer = null;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
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
      for (const hull of this._hulls(ship)) {
        this.overlay.push(hull);
        this.grid.append(hull);
      }
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
    if (this.ghost) this.ghost.forEach((part) => this.grid.append(part));  // keep on top
  }

  _hulls(ship) {
    const rects = rectsCovering(ship.cells);
    const multi = rects.length > 1;
    return rects.map(([r0, c0, r1, c1]) => {
      const hull = el('div', {
        class: 'ship-piece'
          + (multi ? ' part' : '')
          + (ship.sunk ? ' sunk' : '')
          + (ship.selected ? ' selected' : ''),
      });
      hull.style.gridRow = `${r0 + 1} / span ${r1 - r0 + 1}`;
      hull.style.gridColumn = `${c0 + 1} / span ${c1 - c0 + 1}`;
      return hull;
    });
  }

  /** Translucent preview of where a ship would land. */
  showGhost(cells, valid) {
    this.clearGhost();
    if (!cells || !cells.length) return;
    const inside = cells.every(([r, c]) => r >= 0 && c >= 0 && r < this.size && c < this.size);
    if (!inside) return;

    const rects = rectsCovering(cells);
    const multi = rects.length > 1;
    this.ghost = rects.map(([r0, c0, r1, c1]) => {
      const part = el('div', {
        class: `ship-piece ghost${multi ? ' part' : ''}${valid ? '' : ' invalid'}`,
      });
      part.style.gridRow = `${r0 + 1} / span ${r1 - r0 + 1}`;
      part.style.gridColumn = `${c0 + 1} / span ${c1 - c0 + 1}`;
      this.grid.append(part);
      return part;
    });
  }

  clearGhost() {
    if (this.ghost) { this.ghost.forEach((part) => part.remove()); this.ghost = null; }
  }

  shake(hard = false) {
    const cls = hard ? 'shaking-hard' : 'shaking';
    this.grid.classList.remove('shaking', 'shaking-hard');
    void this.grid.offsetWidth;          // restart the animation
    this.grid.classList.add(cls);
  }

  /**
   * Play the "ship destroyed" moment: a shockwave over the wreck and a name
   * plate across the board.
   *
   * These are appended straight to the grid and remove themselves when they
   * finish. render() only clears `this.overlay`, so a redraw mid-animation
   * doesn't cut the celebration short.
   */
  celebrateSunk(cells, name) {
    if (!cells || !cells.length) return;
    const rows = cells.map((cell) => cell[0]);
    const cols = cells.map((cell) => cell[1]);

    const burst = el('div', { class: 'sunk-burst' });
    burst.style.gridRow = `${Math.min(...rows) + 1} / span ${Math.max(...rows) - Math.min(...rows) + 1}`;
    burst.style.gridColumn = `${Math.min(...cols) + 1} / span ${Math.max(...cols) - Math.min(...cols) + 1}`;

    // The plate spans the whole board and centres itself, so a two-cell
    // destroyer's label doesn't get clipped by the grid's edges.
    const plate = el('div', { class: 'sunk-plate' }, [
      el('span', { class: 'skull' }, '☠'),
      el('span', {}, `${name} sunk`),
    ]);

    this.grid.append(burst, plate);
    setTimeout(() => { burst.remove(); plate.remove(); }, 2000);
  }
}

/**
 * Cover a set of cells with as few rectangles as possible.
 *
 * A ship is drawn as solid blocks rather than one box per cell, because the
 * grid has a gap between cells and a block spans its own gaps - that is what
 * makes a five-cell Carrier read as one hull instead of five squares.
 *
 * A straight ship comes back as a single rectangle, exactly as before. A
 * shaped ship - the T-shaped Submarine - comes back as its longest horizontal
 * run plus its longest vertical run, which overlap on the cell they share, so
 * no seam shows where they meet.
 */
export function rectsCovering(cells) {
  const at = (r, c) => `${r},${c}`;
  const rects = [];
  const covered = new Set();

  const runs = (groups, build) => {
    for (const [fixed, movingValues] of groups) {
      const moving = [...movingValues].sort((a, b) => a - b);
      let i = 0;
      while (i < moving.length) {
        let j = i;
        while (j + 1 < moving.length && moving[j + 1] === moving[j] + 1) j++;
        if (j > i) {                      // only runs of two or more are worth a block
          rects.push(build(fixed, moving[i], moving[j]));
          for (let k = moving[i]; k <= moving[j]; k++) covered.add(build.mark(fixed, k));
        }
        i = j + 1;
      }
    }
  };

  const byRow = new Map();
  const byCol = new Map();
  for (const [r, c] of cells) {
    if (!byRow.has(r)) byRow.set(r, []);
    if (!byCol.has(c)) byCol.set(c, []);
    byRow.get(r).push(c);
    byCol.get(c).push(r);
  }

  const horizontal = (r, c0, c1) => [r, c0, r, c1];
  horizontal.mark = (r, c) => at(r, c);
  runs(byRow, horizontal);

  const vertical = (c, r0, r1) => [r0, c, r1, c];
  vertical.mark = (c, r) => at(r, c);
  runs(byCol, vertical);

  // A cell with no neighbour in either direction still needs its own block.
  for (const [r, c] of cells) {
    if (!covered.has(at(r, c))) rects.push([r, c, r, c]);
  }
  return rects;
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
