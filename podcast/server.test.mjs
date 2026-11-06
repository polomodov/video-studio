import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPodcastServer, projectDirectory } from './server.mjs';

const clips = [{ video: 'camera.mp4', start: 1, end: 6, audio: 'voice.wav', audioStart: 2 }];
const media = {
  probe: async path => ({ kind: path.endsWith('.wav') ? 'audio' : 'video', duration: 10, video: 0, audio: 1, details: 'synthetic test metadata' }),
  render: async () => { throw new Error('Unexpected rendering'); },
};

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'podcast-test-')));
  const servers = [];
  t.after(async () => { await Promise.all(servers.map(server => server.close())); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'camera.mp4'), '0123456789');
  await writeFile(join(directory, 'voice.wav'), 'abcdefghij');
  const start = async (options = {}) => {
    const server = await startPodcastServer({ directory, media, ...options });
    servers.push(server);
    return server;
  };
  return { directory, start };
}

function post(server, route, body, extraHeaders = {}) {
  return fetch(server.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url, ...extraHeaders }, body: JSON.stringify(body) });
}

test('sidecar reuses legacy data and rejects ambiguity or symlinks', async (t) => {
  const { directory } = await fixture(t);
  await mkdir(join(directory, '.apollo-montage'));
  assert.equal(await projectDirectory(directory), join(directory, '.apollo-montage'));
  await mkdir(join(directory, '.video-studio-montage'));
  await assert.rejects(projectDirectory(directory), /Найдены/);
  await rm(join(directory, '.video-studio-montage'), { recursive: true });
  await symlink('.apollo-montage', join(directory, '.video-studio-montage'));
  await assert.rejects(projectDirectory(directory), /обычным каталогом/);
});

test('saved edits survive restart; single writer and failed binding release ownership', async (t) => {
  const { directory, start } = await fixture(t);
  const running = await start();
  assert.equal(running.output, join(directory, '.video-studio-montage'));
  assert.equal((await post(running, '/api/project', { clips })).status, 200);
  await assert.rejects(start(), error => error.status === 409);
  await running.close();
  const next = await start();
  assert.deepEqual((await (await fetch(next.url + '/api/project')).json()).clips, clips);
  const other = await mkdtemp(join(tmpdir(), 'podcast-bind-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await assert.rejects(startPodcastServer({ directory: other, media, port: next.server.address().port }), { code: 'EADDRINUSE' });
  const recovered = await startPodcastServer({ directory: other, media });
  await recovered.close();
});

test('invalid WAV range, foreign origins and hostile media names do not mutate projects', async (t) => {
  const { start } = await fixture(t);
  const running = await start();
  await post(running, '/api/project', { clips });
  const before = await readFile(join(running.output, 'project.json'), 'utf8');
  assert.equal((await post(running, '/api/project', { clips: [{ ...clips[0], audioStart: 8 }] })).status, 400);
  assert.equal((await post(running, '/api/project', { clips: [] }, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await fetch(running.url + '/api/project', { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(running.url + '/api/project', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(running.url + '/api/project', { headers: { Host: 'example.invalid' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(running.url + '/media?name=../project.json')).status, 404);
  assert.equal(await readFile(join(running.output, 'project.json'), 'utf8'), before);
  const ranged = await fetch(running.url + '/media?name=camera.mp4', { headers: { Range: 'bytes=2-4' } });
  assert.equal(ranged.status, 206); assert.equal(await ranged.text(), '234');
  const bad = await fetch(running.url + '/media?name=voice.wav', { headers: { Range: 'bytes=-0' } });
  assert.equal(bad.status, 416);
});

test('concurrent render is rejected and graceful shutdown holds the lock until rendering completes', async (t) => {
  const { start } = await fixture(t);
  let finish;
  let calls = 0;
  const rendering = new Promise(resolve => { finish = resolve; });
  const running = await start({ media: { ...media, render: () => { calls++; return rendering; } } });
  assert.equal((await post(running, '/api/render', { clips })).status, 202);
  assert.equal((await post(running, '/api/render', { clips })).status, 400);
  assert.equal(calls, 1);
  const close = running.close();
  await assert.rejects(start(), error => error.status === 409);
  finish('2026-11-06T00-00-00.000Z-episode.mp4');
  await close;
  await start();
});
