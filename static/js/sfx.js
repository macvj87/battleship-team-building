/* Sound effects synthesised in the browser with WebAudio.
 * No audio files to ship, which keeps the whole thing self-contained on a LAN.
 */
const KEY = 'battleship.sound';
let context = null;
let enabled = localStorage.getItem(KEY) === 'on';

function ctx() {
  if (!context) context = new (window.AudioContext || window.webkitAudioContext)();
  if (context.state === 'suspended') context.resume();
  return context;
}

function tone({ type = 'sine', from, to, duration, gain = 0.16, delay = 0 }) {
  if (!enabled) return;
  const audio = ctx();
  const start = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);
  amp.gain.setValueAtTime(gain, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function noise({ duration = 0.4, gain = 0.22, delay = 0 }) {
  if (!enabled) return;
  const audio = ctx();
  const frames = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  const source = audio.createBufferSource();
  const amp = audio.createGain();
  source.buffer = buffer;
  amp.gain.value = gain;
  source.connect(amp).connect(audio.destination);
  source.start(audio.currentTime + delay);
}

export const sfx = {
  get enabled() { return enabled; },
  toggle() {
    enabled = !enabled;
    localStorage.setItem(KEY, enabled ? 'on' : 'off');
    if (enabled) tone({ type: 'triangle', from: 660, to: 990, duration: 0.12, gain: 0.1 });
    return enabled;
  },
  place() { tone({ type: 'square', from: 220, to: 160, duration: 0.07, gain: 0.06 }); },
  fire()  { tone({ type: 'sawtooth', from: 900, to: 200, duration: 0.22, gain: 0.1 }); },
  miss()  { tone({ type: 'sine', from: 500, to: 140, duration: 0.35, gain: 0.12 }); noise({ duration: 0.3, gain: 0.08, delay: 0.05 }); },
  hit()   { noise({ duration: 0.5, gain: 0.3 }); tone({ type: 'sawtooth', from: 180, to: 40, duration: 0.5, gain: 0.2 }); },
  sunk()  { noise({ duration: 0.9, gain: 0.34 }); tone({ type: 'sawtooth', from: 140, to: 30, duration: 0.9, gain: 0.24 }); tone({ type: 'square', from: 300, to: 90, duration: 0.7, gain: 0.1, delay: 0.1 }); },
  turn()  { tone({ type: 'triangle', from: 780, to: 1180, duration: 0.14, gain: 0.09 }); },
  win()   { [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, to: f, duration: 0.5, gain: 0.13, delay: i * 0.13 })); },
  lose()  { [392, 330, 262].forEach((f, i) => tone({ type: 'triangle', from: f, to: f * 0.98, duration: 0.55, gain: 0.12, delay: i * 0.17 })); },
};
