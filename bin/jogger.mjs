#!/usr/bin/env node
// jogger start | open | status | url | install-launchd | uninstall-launchd
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.JOGGER_HOME ?? path.join(os.homedir(), '.jogger');
const port = Number(process.env.JOGGER_PORT ?? 4317);
const label = 'dev.jogger.daemon';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

function token() {
  try {
    return fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function running() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function url() {
  const t = token();
  return t ? `http://127.0.0.1:${port}/?token=${t}` : null;
}

function startForeground() {
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  const child = spawn(process.execPath, ['--import', pathToFileUrl(tsx), path.join(root, 'src', 'server', 'main.ts')], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
  const fwd = (sig) => () => child.kill(sig);
  process.on('SIGINT', fwd('SIGINT'));
  process.on('SIGTERM', fwd('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}

const cmd = process.argv[2] ?? 'start';
switch (cmd) {
  case 'start': {
    const r = await running();
    if (r) {
      console.log(`Jogger ${r.version} is already running. Open: ${url()}`);
      break;
    }
    startForeground();
    break;
  }
  case 'url':
    console.log(url() ?? 'No token yet; start Jogger once first.');
    break;
  case 'open': {
    const u = url();
    if (!u || !(await running())) {
      console.log('Jogger is not running. Start it with: node bin/jogger.mjs start');
      process.exit(1);
    }
    console.log(u);
    if (process.platform === 'darwin') spawn('open', [u], { stdio: 'ignore', detached: true }).unref();
    break;
  }
  case 'status': {
    const r = await running();
    console.log(r ? `running (${r.version}) on 127.0.0.1:${port}` : 'not running');
    console.log(`launchd agent: ${fs.existsSync(plist) ? 'installed' : 'not installed'}`);
    break;
  }
  case 'install-launchd': {
    if (process.platform !== 'darwin') {
      console.log('launchd is macOS only. On Linux, run `node bin/jogger.mjs start` from a systemd user unit.');
      process.exit(1);
    }
    const logDir = path.join(home, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const pathEnv = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.join(root, 'bin', 'jogger.mjs')}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${pathEnv}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'daemon.log')}</string>
</dict></plist>
`,
    );
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { stdio: 'inherit' });
    console.log(`Installed ${plist}. Jogger now starts at login and restarts if it stops. Logs: ${path.join(logDir, 'daemon.log')}`);
    break;
  }
  case 'uninstall-launchd': {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
    fs.rmSync(plist, { force: true });
    console.log('Removed the launchd agent.');
    break;
  }
  default:
    console.log('Usage: jogger [start|open|url|status|install-launchd|uninstall-launchd]');
    process.exit(1);
}
