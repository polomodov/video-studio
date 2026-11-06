import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LayoutTemplateStore, validateLayoutTemplate } from './layout-templates.mjs';

const example = (name = 'Слайды и ведущий') => ({
  name, sourceSize: { width: 1920, height: 1080 }, layout: 'presentation', composition: {
    heading: { x: 40, y: 40, width: 1800, height: 120 },
    slide: { x: 400, y: 200, width: 1400, height: 700 },
    speaker: { x: 0, y: 880, width: 320, height: 180 },
  },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'shorts-templates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new LayoutTemplateStore(root) };
}

test('templates save only composition data, survive reload, and return independent copies', async (t) => {
  const { root, store } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  const input = example('  Слайды и ведущий  ');
  const saved = await store.create(input);
  assert.equal(saved.created, true);
  assert.match(saved.template.id, /^[a-f0-9]{16}$/);
  assert.equal(saved.template.name, 'Слайды и ведущий');
  assert.equal(saved.template.version, 1);
  assert.deepEqual(Object.keys(saved.template), ['version', 'id', 'name', 'sourceSize', 'layout', 'composition', 'createdAt']);
  const expected = structuredClone(saved.template);
  input.composition.speaker.x = 10;
  saved.template.composition.speaker.x = 20;
  const reopened = new LayoutTemplateStore(root);
  const list = await reopened.list();
  assert.deepEqual(list, [expected]);
  list[0].composition.slide.x = 600;
  assert.deepEqual(await reopened.list(), [expected]);
  const file = JSON.parse(await readFile(store.file, 'utf8'));
  assert.deepEqual(file, { version: 1, templates: [expected] });
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
});

test('canonical duplicates are idempotent and concurrent saves do not lose templates', async (t) => {
  const { store } = await fixture(t);
  const original = await store.create(example('Ведущий'));
  const reordered = example(' Ведущии\u0306 ');
  reordered.sourceSize = { height: 1080, width: 1920 };
  reordered.composition.speaker = { height: 180, width: 320, y: 880, x: 0 };
  const duplicate = await store.create(reordered);
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.template, original.template);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.create(example(`Шаблон ${index % 10}`))));
  assert.equal(results.filter((result) => result.created).length, 10);
  assert.equal((await store.list()).length, 11);
  assert.equal(new Set((await store.list()).map((template) => template.id)).size, 11);
});

test('unknown fields and invalid crop regions are rejected without creating a file', async (t) => {
  const { store } = await fixture(t);
  const invalid = [
    { ...example(), sourcePath: '/private/video.mp4' },
    { ...example(), name: '\n' },
    { ...example(), name: 'Шаблон\nдва' },
    { ...example(), layout: 'crop' },
    { ...example(), sourceSize: { width: 1920, height: 1080, path: '/private' } },
    { ...example(), sourceSize: { width: 1920.5, height: 1080 } },
    { ...example(), sourceSize: { width: 0, height: 1080 } },
    { ...example(), composition: { ...example().composition, secret: 'caption' } },
    { ...example(), composition: { ...example().composition, slide: { x: 1800, y: 200, width: 1400, height: 700 } } },
    { ...example(), composition: { ...example().composition, slide: { x: 401, y: 200, width: 1400, height: 700 } } },
    { ...example(), composition: { ...example().composition, speaker: { x: 0, y: 880, width: 320, height: 180, title: 'private' } } },
  ];
  for (const input of invalid) {
    assert.throws(() => validateLayoutTemplate(input), (error) => error.status === 400);
    await assert.rejects(store.create(input), (error) => error.status === 400);
  }
  await assert.rejects(readFile(store.file), { code: 'ENOENT' });
  assert.equal((await store.create(example())).created, true);
});

test('corrupt or unsupported storage reports an actionable error and is never overwritten', async (t) => {
  const { store } = await fixture(t);
  const saved = (await store.create(example())).template;
  for (const contents of ['{broken', JSON.stringify({ version: 2, templates: [] }),
    JSON.stringify({ version: 1, templates: [{ ...saved, id: '0000000000000000' }] }),
    JSON.stringify({ version: 1, templates: [{ ...saved, transcript: 'private' }] })]) {
    await writeFile(store.file, contents);
    await assert.rejects(store.list(), (error) => error.status === 500 && error.message.includes(store.file) && /копии/.test(error.message));
    await assert.rejects(store.create(example('Другой')), (error) => error.status === 500);
    assert.equal(await readFile(store.file, 'utf8'), contents);
  }
  // A failed queued write does not prevent a save after the file is restored.
  await writeFile(store.file, JSON.stringify({ version: 1, templates: [saved] }));
  assert.equal((await store.create(example('Восстановленный'))).created, true);
  assert.equal((await store.list()).length, 2);
});
