import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '0.1.0';

export interface DaemonConfig {
  home: string;
  dbPath: string;
  attachmentsDir: string;
  worktreesDir: string;
  host: string;
  port: number;
  token: string;
  webDir: string | null;
  /** Origins allowed to call the API (the daemon itself plus the Vite dev server). */
  allowedOrigins: Set<string>;
}

export function loadConfig(): DaemonConfig {
  const home = process.env.JOGGER_HOME ?? path.join(os.homedir(), '.jogger');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const attachmentsDir = path.join(home, 'attachments');
  const worktreesDir = path.join(home, 'worktrees');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });

  const tokenFile = path.join(home, 'token');
  let token = process.env.JOGGER_TOKEN ?? '';
  if (!token) {
    if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!token) {
      token = crypto.randomBytes(24).toString('base64url');
      fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    }
  }

  const host = '127.0.0.1';
  const port = Number(process.env.JOGGER_PORT ?? 4317);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const built = path.resolve(here, '../../dist/web');
  const webDir = fs.existsSync(path.join(built, 'index.html')) ? built : null;
  const devPort = Number(process.env.JOGGER_DEV_PORT ?? 5173);
  const allowedOrigins = new Set([
    `http://${host}:${port}`,
    `http://localhost:${port}`,
    `http://${host}:${devPort}`,
    `http://localhost:${devPort}`,
  ]);

  return {
    home,
    dbPath: path.join(home, 'jogger.db'),
    attachmentsDir,
    worktreesDir,
    host,
    port,
    token,
    webDir,
    allowedOrigins,
  };
}

export function newId(prefix = ''): string {
  return prefix + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
}
