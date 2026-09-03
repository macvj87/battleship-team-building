/* One WebSocket connection, with automatic reconnect.
 *
 *   const net = connect({ role: 'player', token });
 *   net.on('state', view => render(view));
 *   net.send({ type: 'fire', row, col });
 */
import { toast } from './util.js';

export function connect(hello, { onOpen, onClose } = {}) {
  const handlers = new Map();
  let socket = null;
  let closedForGood = false;
  let retryDelay = 500;

  function open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);

    socket.addEventListener('open', () => {
      retryDelay = 500;
      socket.send(JSON.stringify(hello));
      if (onOpen) onOpen();
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'notice') { toast(message.message); return; }
      const handler = handlers.get(message.type);
      if (handler) handler(message.type === 'state' ? message.state : message);
    });

    socket.addEventListener('close', () => {
      if (onClose) onClose();
      if (closedForGood) return;
      setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 1.7, 5000);   // back off, but keep trying
    });
  }
  open();

  return {
    on(type, handler) { handlers.set(type, handler); },
    send(message) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() { closedForGood = true; if (socket) socket.close(); },
  };
}
