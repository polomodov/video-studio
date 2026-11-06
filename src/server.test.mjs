import { defaultComposition } from './ui/composition.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Studio } from './workflow.mjs';
import { validateProposals } from './core.mjs';
import { startServer } from './server.mjs';
import { acquireLock } from './lock.mjs';

const sourceBytes = '0123456789ABCDEFGHIJ';
const segments = [{ id: 's00001', start: 1, end: 12, text: 'Самостоятельная мысль.' }];
function request(url, route, { method = 'GET', headers = {}, data } = {}) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request(new URL(route, url), {
      method, headers: { Connection: 'close', ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTP test timed out')));
    req.end(payload);
  });
}
async function fixture(t, { start = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'shorts-http-'));
  let running;
  t.after(async () => { if (running) await running.close(); await rm(root, { recursive: true, force: true }); });
  let renders = 0;
  const studio = new Studio({ root, media: {
    probeMedia: async () => ({ duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true }),
    createPoster: async () => {},
    renderClip: async () => { renders++; throw new Error('Unexpected render'); },
  } });
  const source = path.join(root, 'source.mp4'); await writeFile(source, sourceBytes);
  const job = await studio.importSource(source);
  await studio.store.update(job.id, (current) => {
    current.status = 'ready'; current.segments = segments;
    current.candidates = validateProposals({ candidates: [{ startSegmentId: 's00001', endSegmentId: 's00001', title: 'Тезис', reason: 'Законченное объяснение.', contextRisk: '' }] }, segments, 60);
  });
  if (start) running = await startServer({ studio, port: 0 });
  return { root, studio, id: job.id, get renders() { return renders; }, get running() { return running; } };
}

test('foreign Origin, Host and cross-site requests are refused before any mutation', async (t) => {
  const { studio, id, running } = await fixture(t);
  const before = await readFile(path.join(studio.store.dir(id), 'job.json'), 'utf8');
  for (const headers of [{ Origin: 'https://foreign.example' }, { Host: 'foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const result = await request(running.url, `/api/jobs/${id}/candidates/clip-01`, { method: 'PATCH', headers, data: { selected: true } });
    assert.equal(result.status, 403);
  }
  assert.equal(await readFile(path.join(studio.store.dir(id), 'job.json'), 'utf8'), before);
  const permitted = await request(running.url, '/api/jobs', { headers: { Origin: running.url } });
  assert.equal(permitted.status, 200);
});

test('layout templates use the same origin guards and return validated reusable data', async (t) => {
  const { root, running } = await fixture(t);
  const route = '/api/layout-templates';
  const input = {
    name: 'Слайды и ведущий', sourceSize: { width: 1920, height: 1080 }, layout: 'presentation', composition: {
      heading: { x: 0, y: 0, width: 1920, height: 100 },
      slide: { x: 400, y: 100, width: 1400, height: 800 },
      speaker: { x: 0, y: 880, width: 320, height: 180 },
    },
  };
  assert.deepEqual(JSON.parse((await request(running.url, route)).text), { templates: [] });
  for (const headers of [{ Origin: 'https://foreign.example' }, { Host: 'foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(running.url, route, { method: 'POST', headers, data: input })).status, 403);
  }
  await assert.rejects(readFile(path.join(root, 'layout-templates.json')), { code: 'ENOENT' });
  const created = await request(running.url, route, { method: 'POST', headers: { Origin: running.url }, data: input });
  assert.equal(created.status, 201);
  const { template } = JSON.parse(created.text);
  assert.deepEqual(template.composition, input.composition);
  assert.deepEqual(template.sourceSize, input.sourceSize);
  assert.equal(template.name, input.name);
  assert.match(template.id, /^[a-f0-9]{16}$/);
  const duplicate = await request(running.url, route, { method: 'POST', data: input });
  assert.equal(duplicate.status, 200); assert.deepEqual(JSON.parse(duplicate.text), { template });
  assert.deepEqual(JSON.parse((await request(running.url, route)).text), { templates: [template] });
  assert.equal((await request(running.url, route, { method: 'POST', data: { ...input, transcript: 'private' } })).status, 400);
  assert.equal((await request(running.url, route, { method: 'POST', data: { ...input, composition: {} } })).status, 400);
  assert.deepEqual(JSON.parse((await request(running.url, route)).text), { templates: [template] });
});

test('media ranges return exact bytes, HEAD metadata and valid 416 responses', async (t) => {
  const { id, running } = await fixture(t), route = `/media/${id}/source`;
  const part = await request(running.url, route, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206); assert.equal(part.text, '2345');
  assert.equal(part.headers['content-range'], `bytes 2-5/${sourceBytes.length}`);
  const suffix = await request(running.url, route, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.text, 'GHIJ');
  const head = await request(running.url, route, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(Number(head.headers['content-length']), sourceBytes.length);
  for (const value of ['bytes=99-', 'bytes=8-3', 'bytes=0-1,3-4']) {
    const response = await request(running.url, route, { headers: { Range: value } });
    assert.equal(response.status, 416); assert.equal(response.headers['content-range'], `bytes */${sourceBytes.length}`);
  }
});

test('only current manifest exports are served; edits remove access to old files', async (t) => {
  const { studio, id, running } = await fixture(t);
  const dir = path.join(studio.store.dir(id), 'exports'); await mkdir(dir);
  await writeFile(path.join(dir, 'approved.mp4'), 'approved'); await writeFile(path.join(dir, 'orphan.mp4'), 'private');
  await studio.store.update(id, (job) => {
    job.candidates[0].export = { videoFile: 'approved.mp4', srtFile: 'approved.srt', descriptionFile: 'approved.txt' };
    job.candidates[0].renderStatus = 'ready';
  });
  assert.equal((await request(running.url, `/media/${id}/exports/approved.mp4`)).text, 'approved');
  for (const route of [`/media/${id}/exports/orphan.mp4`, `/media/${id}/job.json`, `/media/${id}/exports/..%2fjob.json`]) {
    assert.equal((await request(running.url, route)).status, 404);
  }
  assert.equal((await request(running.url, `/api/jobs/${id}/candidates/clip-01`, { method: 'PATCH', data: { title: 'Изменённый заголовок' } })).status, 200);
  assert.equal((await request(running.url, `/media/${id}/exports/approved.mp4`)).status, 404);
});

test('render endpoint refuses an unselected candidate without invoking the renderer', async (t) => {
  const fixtureData = await fixture(t), { studio, id, running } = fixtureData;
  const result = await request(running.url, `/api/jobs/${id}/render`, { method: 'POST', data: { candidateIds: ['clip-01'] } });
  assert.equal(result.status, 400); assert.match(result.text, /выбранные/);
  await studio.idle(id);
  assert.equal(fixtureData.renders, 0);
  assert.equal((await studio.store.get(id)).candidates[0].selected, false);
});

test('exports download under the Russian block title without changing playback or range responses', async (t) => {
  const { studio, id, running } = await fixture(t);
  const dir = path.join(studio.store.dir(id), 'exports'); await mkdir(dir);
  const title = 'Сколько на самом деле стоит работа агентов';
  await studio.store.update(id, (job) => {
    job.candidates[0].title = title;
    job.candidates[0].export = { videoFile: 'clip-01-abc.mp4', srtFile: 'clip-01-abc.srt', descriptionFile: 'clip-01-abc.txt' };
  });
  for (const extension of ['mp4', 'srt', 'txt']) {
    await writeFile(path.join(dir, `clip-01-abc.${extension}`), sourceBytes);
    const response = await request(running.url, `/media/${id}/exports/clip-01-abc.${extension}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206); assert.equal(response.text, '2345');
    assert.match(response.headers['content-disposition'], /^inline; /);
    assert.equal(decodeURIComponent(response.headers['content-disposition'].split("filename*=UTF-8''")[1]), `${title}.${extension}`);
  }
  await studio.store.update(id, (job) => { job.candidates[0].title = 'Тест / заголовка:\r\n' + 'я'.repeat(200); });
  const head = await request(running.url, `/media/${id}/exports/clip-01-abc.mp4`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
  const name = decodeURIComponent(head.headers['content-disposition'].split("filename*=UTF-8''")[1]);
  assert.ok(name.startsWith('Тест заголовка '));
  assert.ok(name.endsWith('.mp4') && Buffer.byteLength(name) <= 224);
  assert.equal((await readFile(path.join(dir, 'clip-01-abc.mp4'), 'utf8')), sourceBytes);
});

test('a second server cannot recover or mutate a live writer; close releases ownership', async (t) => {
  const { root, studio, id, running } = await fixture(t);
  await studio.store.update(id, (job) => { job.status = 'transcribing'; });
  const before = await readFile(path.join(studio.store.dir(id), 'job.json'), 'utf8');
  await assert.rejects(startServer({ root, port: 0 }), (error) => error.status === 409);
  assert.equal(await readFile(path.join(studio.store.dir(id), 'job.json'), 'utf8'), before);
  await running.close();
  const release = await acquireLock(root); await release();
});

test('failed port binding and failed recovery both release their cache lock', async (t) => {
  const first = await fixture(t), second = await fixture(t, { start: false });
  let recoveryCalls = 0;
  second.studio.store.recover = async () => { recoveryCalls++; };
  await assert.rejects(startServer({ studio: second.studio, port: first.running.server.address().port }), (error) => error.code === 'EADDRINUSE');
  // Recovery runs under the cache lock before accepting any HTTP requests.
  assert.equal(recoveryCalls, 1);
  let release = await acquireLock(second.root); await release();
  second.studio.store.recover = async () => { throw new Error('Recovery failed'); };
  await assert.rejects(startServer({ studio: second.studio, port: 0 }), /Recovery failed/);
  release = await acquireLock(second.root); await release();
});

for (const layout of ['duo', 'slide-speaker']) test(`${layout} PATCH/templates persist and reject a mismatched shape without mutation`, async (t) => {
  const { studio, id, running } = await fixture(t);
  const composition = defaultComposition(layout, { width: 1920, height: 1080 });
  const route = `/api/jobs/${id}/candidates/clip-01`;
  const result = await request(running.url, route, { method: 'PATCH', data: { layout, composition } });
  assert.equal(result.status, 200);
  assert.deepEqual((await studio.store.get(id)).candidates[0].composition, composition);
  const bad = await request(running.url, route, { method: 'PATCH', data: { layout: layout === 'duo' ? 'slide-speaker' : 'duo', composition } });
  assert.equal(bad.status, 400);
  assert.equal((await studio.store.get(id)).candidates[0].layout, layout);
  const input = { name: layout, sourceSize: { width: 1920, height: 1080 }, layout, composition };
  assert.equal((await request(running.url, '/api/layout-templates', { method: 'POST', data: input })).status, 201);
  const templates = JSON.parse((await request(running.url, '/api/layout-templates')).text).templates;
  assert.equal(templates[0].layout, layout);
  assert.deepEqual(templates[0].composition, composition);
  for (const file of ['composition.mjs', 'composition-editor.mjs', 'captions.mjs']) assert.equal((await request(running.url, `/${file}`)).status, 200);
});

test('explicit analyze target appends candidates over HTTP and rejects an out-of-range target', async (t) => {
  const { studio, id, running } = await fixture(t);
  await studio.store.update(id, job => { job.segments.push({ id: 's00002', start: 20, end: 30, text: 'Другая история.' }); });
  studio.select = async () => ({ candidates: [{ startSegmentId: 's00002', endSegmentId: 's00002', title: 'Дополнение', reason: 'Самостоятельная мысль.', contextRisk: '' }] });
  const route = `/api/jobs/${id}/analyze`;
  assert.equal((await request(running.url, route, { method: 'POST', data: { targetCount: 16 } })).status, 400);
  assert.equal((await request(running.url, route, { method: 'POST', data: { targetCount: 2 } })).status, 202);
  await studio.idle(id);
  assert.equal((await studio.store.get(id)).candidates.length, 2);
});
