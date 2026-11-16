#!/usr/bin/env node
// Dev mode: daemon (auto-restarting) + Vite with hot reload. Open the URL printed by the daemon,
// but on port 5173: http://127.0.0.1:5173/?token=... (the Vite proxy forwards the cookie).
import { spawn } from 'node:child_process';
const procs = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server/main.ts'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; }));
