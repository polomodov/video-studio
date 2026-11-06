import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store, normalizeSegments, validateProposals, editCandidate, selectedForRender, verifySource } from './core.mjs';
import { Studio } from './workflow.mjs';
import { selectWithCodex } from './codex.mjs';

const segments = [{ id: 's00001', start: 1, end: 10, text: 'Вопрос.' }, { id: 's00002', start: 10, end: 25, text: 'Ответ с условием.' }];
const proposal = { candidates: [{ startSegmentId: 's00001', endSegmentId: 's00002', title: 'Тезис', reason: 'Есть объяснение.', contextRisk: '' }] };
const metadata = { duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shorts-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'исходник.mp4'); await writeFile(sourcePath, 'synthetic-source');
  const store = new Store(root); const job = await store.importSource(sourcePath, async () => metadata);
  await store.update(job.id, (current) => {
    current.segments = segments; current.candidates = validateProposals(proposal, segments, 60); current.status = 'ready';
  });
  return { root, sourcePath, store, id: job.id };
}
test('Codex segment references determine times; unknown IDs and duplicates fail closed', () => {
  assert.equal(validateProposals(proposal, segments, 60)[0].end, 25);
  const bad = structuredClone(proposal); bad.candidates[0].endSegmentId = 'invented';
  assert.throws(() => validateProposals(bad, segments, 60), /неизвестные реплики/);
  assert.throws(() => validateProposals({ candidates: [...proposal.candidates, ...proposal.candidates] }, segments, 60), /повторяющиеся/);
  assert.throws(() => validateProposals(proposal, segments, 20), /180/);
});
test('Whisper tail overshoot is clamped; zero or reversed timings are rejected', () => {
  assert.equal(normalizeSegments({ transcription: [{ offsets: { from: 5000, to: 11150 }, text: 'Речь' }] }, 10)[0].end, 10);
  assert.throws(() => normalizeSegments({ segments: [{ start: 1, end: 1, text: 'Речь' }] }, 10), /границы/);
  assert.throws(() => normalizeSegments({ segments: [{ start: 3, end: 5, text: 'А' }, { start: 1, end: 2, text: 'Б' }] }, 10), /границы/);
});
test('edits persist on reload and invalidate exports, selection alone does not', async (t) => {
  const { root, store, id } = await fixture(t); const job = await store.get(id);
  const candidate = { ...job.candidates[0], export: { videoFile: 'old.mp4' }, renderStatus: 'ready' };
  const selected = editCandidate(candidate, { selected: true }, job); assert.ok(selected.export);
  const changed = editCandidate(selected, { title: 'Новый заголовок', captionEdits: { s00002: 'Исправление' } }, job);
  assert.equal(changed.export, null); assert.equal(changed.renderStatus, 'stale');
  await store.update(id, (current) => { current.candidates[0] = changed; });
  assert.equal((await new Store(root).get(id)).candidates[0].captionEdits.s00002, 'Исправление');
  assert.throws(() => editCandidate(candidate, { start: -1 }, job));
  assert.throws(() => editCandidate(candidate, { captionEdits: { '__unknown': 'x' } }, job));
  assert.throws(() => selectedForRender(job, ['clip-01']), /выбранные/);
});
test('presentation regions are canonical, bounded even pixels and invalidate the old export', async (t) => {
  const { store, id } = await fixture(t); const job = await store.get(id);
  const candidate = { ...job.candidates[0], export: { videoFile: 'old.mp4' }, renderStatus: 'ready' };
  const composition = { speaker: { height: 192, width: 216, y: 858, x: 104 },
    heading: { x: 100, y: 136, width: 1060, height: 128 }, slide: { x: 420, y: 444, width: 1080, height: 430 } };
  const changed = editCandidate(candidate, { layout: 'presentation', composition }, job);
  assert.deepEqual(Object.keys(changed.composition), ['heading', 'slide', 'speaker']);
  assert.deepEqual(Object.keys(changed.composition.speaker), ['x', 'y', 'width', 'height']);
  assert.equal(changed.export, null); assert.equal(changed.renderStatus, 'stale');
  await store.update(id, (current) => { current.candidates[0] = changed; });
  assert.deepEqual((await store.get(id)).candidates[0].composition, changed.composition);
  assert.throws(() => editCandidate(candidate, { layout: 'presentation' }, job), /области/);
  for (const rect of [{ x: -2 }, { y: 1 }, { width: 0 }, { height: 1.5 }, { x: 1900 }, { height: 2000 }, { x: '0;movie=secret' }, { extra: 2 }]) {
    assert.throws(() => editCandidate(candidate, { composition: { ...composition, heading: { ...composition.heading, ...rect } } }, job));
  }
  assert.throws(() => editCandidate(candidate, { composition: { ...composition, extra: {} } }, job));
  assert.throws(() => editCandidate(candidate, { composition: null }, job));
  const ready = { ...changed, export: { videoFile: 'new.mp4' }, renderStatus: 'ready' };
  assert.equal(editCandidate(ready, { selected: true }, job).export.videoFile, 'new.mp4');
  assert.equal(editCandidate(ready, { composition: { ...composition, speaker: { ...composition.speaker, x: 106 } } }, job).export, null);
});
test('content-identical reimport repairs moved/touched source and preserves choices', async (t) => {
  const { root, sourcePath, store, id } = await fixture(t);
  await store.update(id, (job) => { job.candidates[0].selected = true; });
  await utimes(sourcePath, new Date(), new Date(Date.now() + 5000));
  await assert.rejects(verifySource((await store.get(id)).source), /изменился/);
  const copy = path.join(root, 'перенесённый.mp4'); await writeFile(copy, 'synthetic-source');
  const job = await store.importSource(copy, async () => metadata);
  assert.equal(job.id, id); assert.equal(job.source.path, await realpath(copy)); assert.equal(job.candidates[0].selected, true);
  await verifySource(job.source);
});
test('render reads selection atomically after a concurrent deselection', async (t) => {
  const { root, store, id } = await fixture(t);
  await store.update(id, (job) => { job.candidates[0].selected = true; });
  let renders = 0;
  const studio = new Studio({ root, media: { renderClip: async () => { renders++; } } });
  let unblock;
  const barrier = new Promise((resolve) => { unblock = resolve; });
  const deselect = studio.store.update(id, async (job) => { await barrier; job.candidates[0].selected = false; });
  const rejection = assert.rejects(studio.render(id, ['clip-01']), /выбранные/);
  unblock(); await deselect; await rejection; await studio.idle(id);
  assert.equal(renders, 0);
});
test('saved transcript is reused after selection failure instead of retranscribing', async (t) => {
  const { root, store, id } = await fixture(t);
  await store.update(id, (job) => { job.candidates = []; job.transcription = { sourceSha256: job.source.sha256 }; });
  let transcriptions = 0, selections = 0;
  const studio = new Studio({ root, media: { transcribe: async () => { transcriptions++; } }, select: async () => {
    selections++; if (selections === 1) throw new Error('Нет соединения'); return proposal;
  } });
  await studio.prepare(id); assert.equal((await studio.idle(id)).status, 'error');
  await studio.prepare(id); const job = await studio.idle(id);
  assert.equal(job.status, 'ready'); assert.equal(transcriptions, 0); assert.equal(selections, 2);
});
test('attached transcripts retain imported provenance and skip speech recognition', async (t) => {
  const { root, store, id } = await fixture(t);
  await store.update(id, (job) => { job.candidates = []; job.segments = []; job.transcription = null; });
  const studio = new Studio({ root, media: {
    transcribe: async () => { throw new Error('Imported transcript must not be transcribed again'); },
  }, select: async () => proposal });
  const imported = await studio.attachTranscript(id, { segments });
  assert.equal(imported.transcription.engine, 'imported');
  assert.equal(imported.transcription.sourceSha256, imported.source.sha256);
  await studio.prepare(id);
  const ready = await studio.idle(id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.transcription.engine, 'imported');
});
test('missing Codex command produces an actionable error and no synthetic candidates', async (t) => {
  const { root, store, id } = await fixture(t);
  const previous = process.env.SHORTS_CODEX;
  process.env.SHORTS_CODEX = path.join(root, 'not-installed');
  try { await assert.rejects(selectWithCodex(await store.get(id), root), /Codex CLI не найден/); }
  finally { if (previous === undefined) delete process.env.SHORTS_CODEX; else process.env.SHORTS_CODEX = previous; }
});
test('damaged saved transcript is preserved and retried with fresh transcription', async (t) => {
  const { root, store, id } = await fixture(t);
  await store.update(id, (job) => { job.candidates = []; job.segments = []; job.transcription = null; });
  await writeFile(path.join(store.dir(id), 'transcript.raw.json'), '{broken');
  let calls = 0;
  const studio = new Studio({ root, media: { transcribe: async () => { calls++; return { segments }; } }, select: async () => proposal });
  await studio.prepare(id); const job = await studio.idle(id);
  assert.equal(job.status, 'ready'); assert.equal(calls, 1); assert.equal(job.candidates.length, 1);
  assert.equal(job.transcription.engine, 'whisper.cpp');
});
test('Codex login failure is actionable and never replaced by invented candidates', async (t) => {
  const { root, store, id } = await fixture(t);
  const binary = path.join(root, 'codex-auth-failure');
  await writeFile(binary, '#!/bin/sh\necho "401 unauthorized login required" >&2\nexit 1\n', { mode: 0o700 });
  const previous = process.env.SHORTS_CODEX;
  process.env.SHORTS_CODEX = binary;
  try { await assert.rejects(selectWithCodex(await store.get(id), root), /Требуется вход через codex login/); }
  finally { if (previous === undefined) delete process.env.SHORTS_CODEX; else process.env.SHORTS_CODEX = previous; }
});

test('expanded selection appends stable IDs and preserves existing edits and exports', async (t) => {
  const { root, store, id } = await fixture(t);
  await store.update(id, job => { job.segments.push({ id: 's00003', start: 30, end: 40, text: 'Другая история.' }); job.candidates[0].selected = true; job.candidates[0].title = 'Авторская правка'; job.candidates[0].export = { revision: 'saved-result', videoFile: 'saved.mp4' }; job.candidates[0].renderStatus = 'ready'; });
  const before = (await store.get(id)).candidates[0]; let options;
  const studio = new Studio({ root, select: async (_job, _dir, input) => { options = input; return { candidates: [{ ...proposal.candidates[0], startSegmentId: 's00003', endSegmentId: 's00003' }] }; } });
  await studio.expand(id, 2); await studio.idle(id);
  const job = await store.get(id);
  assert.deepEqual(job.candidates[0], before); assert.equal(job.candidates[1].id, 'clip-02');
  assert.equal(options.count, 1); assert.equal(options.exclude[0].start, before.start);
  assert.equal((await studio.expand(id, 2)).candidates.length, 2);
  await assert.rejects(studio.expand(id, 16));
});
test('expansion rejects overlaps against concurrent edits without changing existing candidates', async (t) => {
  const { root, store, id } = await fixture(t);
  await store.update(id, job => { job.segments.push({ id: 's00003', start: 30, end: 40, text: 'Другая история.' }); });
  const studio = new Studio({ root, select: async () => {
    await store.update(id, job => { job.candidates[0].end = 35; });
    return { candidates: [{ ...proposal.candidates[0], startSegmentId: 's00003', endSegmentId: 's00003' }] };
  } });
  await studio.expand(id, 2); await studio.idle(id);
  const job = await store.get(id); assert.equal(job.candidates.length, 1); assert.equal(job.candidates[0].end, 35); assert.ok(job.error);
});

test('15 proposals and selected render IDs are accepted; 16 are rejected', () => {
  const entries = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, start: i * 10, end: i * 10 + 8, text: 'История' }));
  const proposals = entries.map(s => ({ ...proposal.candidates[0], startSegmentId: s.id, endSegmentId: s.id }));
  const candidates = validateProposals({ candidates: proposals.slice(0, 15) }, entries, 200).map(c => ({ ...c, selected: true }));
  assert.equal(selectedForRender({ candidates }, candidates.map(c => c.id)).length, 15);
  assert.throws(() => validateProposals({ candidates: proposals }, entries, 200));
  assert.throws(() => selectedForRender({ candidates }, Array.from({ length: 16 }, (_, i) => `clip-${i}`)));
});
