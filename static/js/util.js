/* Small helpers shared by every page. No framework, no build step. */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** el('div', {class:'panel'}, [child, 'text']) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const key = (row, col) => `${row},${col}`;

/** (0,0) -> "A1", the way people call out a square */
export const cellLabel = (row, col) => String.fromCharCode(65 + col) + (row + 1);

export function clock(seconds) {
  if (seconds === null || seconds === undefined) return '--:--';
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function timeAgo(epochSeconds) {
  if (!epochSeconds) return '-';
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

let toastHost = null;
export function toast(message) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-stack' });
    document.body.append(toastHost);
  }
  // An impatient team clicking six times shouldn't get six identical toasts.
  const showing = Array.from(toastHost.children).some((t) => t.textContent === message);
  if (showing) return;
  const node = el('div', { class: 'toast' }, message);
  toastHost.append(node);
  setTimeout(() => node.remove(), 3200);
}

/** How many seconds are left when we start warning people. */
export const WARN_SECONDS = 10;

/** Countdown ring + digits. The server sends the truth once a second; we
 *  smooth the gap locally so the ring doesn't tick in jumps.
 *
 *  Call `onWarning(fn)` to be told once per second over the last
 *  WARN_SECONDS, which is what drives the audible countdown. */
export function makeClock(label = 'Time') {
  const value = el('circle', {}, []);
  const root = el('div', { class: 'clock' });
  root.innerHTML = `
    <div class="ring">
      <svg viewBox="0 0 44 44">
        <circle class="track" cx="22" cy="22" r="18"></circle>
        <circle class="value" cx="22" cy="22" r="18"
                stroke-dasharray="113" stroke-dashoffset="0"></circle>
      </svg>
    </div>
    <div>
      <div class="digits">--:--</div>
      <div class="label">${label}</div>
    </div>`;

  const ring = root.querySelector('.value');
  const digits = root.querySelector('.digits');
  let remaining = null, total = null, paused = false, lastSync = performance.now();
  let lastWholeSecond = null;
  let warningHandler = null;

  function paint() {
    const now = performance.now();
    let shown = remaining;
    if (shown !== null && !paused) shown = Math.max(0, shown - (now - lastSync) / 1000);
    digits.textContent = clock(shown);
    const fraction = shown !== null && total ? Math.max(0, Math.min(1, shown / total)) : 0;
    ring.style.strokeDashoffset = String(113 * (1 - fraction));
    root.classList.toggle('low', shown !== null && shown <= WARN_SECONDS);

    // Fire once as each of the last few seconds ticks over.
    const whole = shown === null ? null : Math.ceil(shown);
    if (whole !== lastWholeSecond) {
      if (warningHandler && whole !== null && whole > 0 && whole <= WARN_SECONDS && !paused) {
        warningHandler(whole);
      }
      lastWholeSecond = whole;
    }

    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);

  return {
    node: root,
    setLabel(text) { root.querySelector('.label').textContent = text; },
    sync(r, t, isPaused) { remaining = r; total = t; paused = !!isPaused; lastSync = performance.now(); },
    onWarning(fn) { warningHandler = fn; },
  };
}
