import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Worktree } from '../shared/protocol.js';

const run = promisify(execFile);

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await run('git', ['-C', dir, 'rev-parse', '--git-dir'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Create a worktree on a new branch from the project's current HEAD. */
export async function createWorktree(projectPath: string, root: string, name: string): Promise<Worktree> {
  if (!(await isGitRepo(projectPath))) throw new Error(`${projectPath} is not a git repository, so it can't have worktrees.`);
  const project = path.basename(projectPath);
  let branch = `jogger/${name}`;
  let dir = path.join(root, project, name);
  for (let i = 2; fs.existsSync(dir) || (await branchExists(projectPath, branch)); i++) {
    branch = `jogger/${name}-${i}`;
    dir = path.join(root, project, `${name}-${i}`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    await run('git', ['-C', projectPath, 'worktree', 'add', '-b', branch, dir, 'HEAD'], { timeout: 60000 });
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (/invalid reference: HEAD|not a valid object name/i.test(msg))
      throw new Error('The repository has no commits yet. Make a first commit before starting a thread in a worktree.');
    throw new Error(msg.trim());
  }
  return { path: dir, branch };
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
