import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { acquireLock, LOCK_FILE } from './lock.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'shorts-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return child.pid;
}

test('a live owner refuses a second writer; release is idempotent and allows reacquisition', async (t) => {
  const root = await fixture(t);
  const release = await acquireLock(root);
  const first = JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8'));
  assert.equal(first.pid, process.pid);
  await assert.rejects(acquireLock(root), (error) => error.status === 409);
  const firstRelease = release();
  assert.equal(release(), firstRelease);
  await firstRelease; await release();
  const nextRelease = await acquireLock(root);
  const second = JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8'));
  assert.notEqual(second.token, first.token);
  await nextRelease();
  assert.deepEqual(await readdir(root), []);
});

test('concurrent first acquisitions produce exactly one owner', async (t) => {
  const root = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => acquireLock(root)));
  const winners = results.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.status === 409));
  await winners[0].value();
  assert.deepEqual(await readdir(root), []);
});

test('concurrent stale recovery preserves the new owner', async (t) => {
  const root = await fixture(t), pid = await deadPid();
  await writeFile(path.join(root, LOCK_FILE), JSON.stringify({ pid, token: randomUUID() }));
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => acquireLock(root)));
  const winners = results.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8')).pid, process.pid);
  await winners[0].value();
  assert.deepEqual(await readdir(root), []);
});

test('release cannot remove a record owned by a different token', async (t) => {
  const root = await fixture(t);
  const release = await acquireLock(root);
  const replacement = { pid: process.pid, token: randomUUID() };
  await writeFile(path.join(root, LOCK_FILE), JSON.stringify(replacement));
  await release();
  assert.deepEqual(JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8')), replacement);
});

test('a crash during stale reclaim leaves a recoverable guard', async (t) => {
  const root = await fixture(t), pid = await deadPid(), token = randomUUID();
  const guardId = createHash('sha256').update(`${LOCK_FILE}:${token}`).digest('hex');
  await writeFile(path.join(root, LOCK_FILE), JSON.stringify({ pid, token }));
  await writeFile(path.join(root, `.shorts-reclaim-${guardId}.lock`), JSON.stringify({ pid, token: randomUUID() }));
  const release = await acquireLock(root);
  assert.equal(JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8')).pid, process.pid);
  await release();
  assert.deepEqual(await readdir(root), []);
});

test('a malformed lock is refused without deleting evidence', async (t) => {
  const root = await fixture(t), file = path.join(root, LOCK_FILE);
  await writeFile(file, 'incomplete');
  await assert.rejects(acquireLock(root), (error) => error.status === 409);
  assert.equal(await readFile(file, 'utf8'), 'incomplete');
});
