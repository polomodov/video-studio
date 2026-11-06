import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, DEFAULT_ROOT } from './core.mjs';

export const LOCK_FILE = '.shorts-process.lock';
const busy = () => new AppError('Этот каталог Shorts уже открыт другим процессом. Остановите предыдущий сервер или CLI и повторите.', 409);

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
async function ownerAt(file) {
  try {
    const owner = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 ||
      typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.token)) throw new Error('invalid owner');
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new AppError('Не удалось проверить файл блокировки Shorts. Сначала остановите другие процессы и проверьте каталог данных.', 409);
  }
}

// Publish a complete record atomically: an observer never sees an empty lockfile.
// A token-specific reclaim guard serializes stale takeovers. Guards can themselves
// be reclaimed after a crash using the same protocol and bounded recursion.
async function acquireFile(file, root, depth = 0) {
  if (depth > 8) throw busy();
  const owner = { version: 1, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  const temporary = path.join(root, `.shorts-${owner.token}.tmp`);
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  let releasePromise;
  const release = () => {
    // close() and the server's close listener may both release concurrently.
    // Coalesce them so a delayed second unlink cannot remove a new claimant.
    releasePromise ??= (async () => {
      const current = await ownerAt(file);
      if (current?.token === owner.token && current.pid === owner.pid) await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    })();
    return releasePromise;
  };
  try {
    for (let attempt = 0; attempt < 16; attempt++) {
      try { await link(temporary, file); return release; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const existing = await ownerAt(file);
      if (!existing) continue;
      if (processAlive(existing.pid)) throw busy();
      const guardId = createHash('sha256').update(`${path.basename(file)}:${existing.token}`).digest('hex');
      const releaseGuard = await acquireFile(path.join(root, `.shorts-reclaim-${guardId}.lock`), root, depth + 1);
      try {
        const current = await ownerAt(file);
        // A different contender may have replaced the old lock before our guard.
        if (current?.token !== existing.token || current.pid !== existing.pid) continue;
        if (processAlive(current.pid)) throw busy();
        await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        // A new claimant can win the empty slot. Never overwrite its record.
        try { await link(temporary, file); return release; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await releaseGuard(); }
    }
    throw busy();
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function acquireLock(root = DEFAULT_ROOT) {
  const directory = path.resolve(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return acquireFile(path.join(directory, LOCK_FILE), directory);
}

// CLI owners can use this for Ctrl+C/SIGTERM; normal completion should still
// await release in finally. SIGKILL/crash leaves a safely reclaimable stale PID.
export function releaseOnExit(release) {
  let stopping = false;
  const listeners = new Map();
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const listener = () => {
      if (stopping) return;
      stopping = true;
      Promise.resolve().then(release).catch(() => {}).finally(() => process.exit(code));
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  const beforeExit = () => { Promise.resolve().then(release).catch(() => {}); };
  process.once('beforeExit', beforeExit);
  return () => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    process.removeListener('beforeExit', beforeExit);
  };
}
