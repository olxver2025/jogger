import { EventEmitter } from 'node:events';
import type { ServerMessage } from '../shared/protocol.js';

/** Fan-out to WebSocket clients and in-process listeners (Telegram bridge, tests). */
export class Hub extends EventEmitter {
  broadcast(msg: ServerMessage) {
    this.emit('message', msg);
  }
  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.on('message', fn);
    return () => this.off('message', fn);
  }
}
