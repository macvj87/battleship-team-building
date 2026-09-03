/* The join screen. Claims a slot over plain HTTP so that errors ("both slots
 * are full", "name taken") can be shown clearly, then hands off to /play. */
import { $ } from './util.js';

const TOKEN_KEY = 'battleship.token';

const form = $('#form');
const nameInput = $('#name');
const errorLine = $('#error');
const submit = $('#submit');
const status = $('#status');

// A team that already joined - refreshed the page, or their laptop slept -
// goes straight back into their game instead of joining again.
const saved = localStorage.getItem(TOKEN_KEY);
if (saved) {
  fetch(`/api/session?token=${encodeURIComponent(saved)}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.valid) location.replace('/play');
      else localStorage.removeItem(TOKEN_KEY);
    })
    .catch(() => {});
}

showLobbyStatus();
setInterval(showLobbyStatus, 4000);

async function showLobbyStatus() {
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    status.textContent = `Server ready at ${info.lanUrl}`;
  } catch (err) {
    status.textContent = 'Cannot reach the game server.';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorLine.textContent = '';
  submit.disabled = true;
  submit.textContent = 'Joining…';

  try {
    const response = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameInput.value, token: saved }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Could not join');
    localStorage.setItem(TOKEN_KEY, data.token);
    location.href = '/play';
  } catch (err) {
    errorLine.textContent = err.message;
    submit.disabled = false;
    submit.textContent = 'Enter the battle';
  }
});
