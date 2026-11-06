import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { escapeAss, renderRevision, subtitleCues, subtitlesAss, subtitlesSrt, transcribe, transcriptProblem, videoFilterArgs } from './media.mjs';

test('subtitles clip to local time and edits remain attached to segment IDs', () => {
  const segments = [
    { id: 's1', start: 0, end: 3, text: 'До фрагмента' },
    { id: 's2', start: 3, end: 8, text: 'Первый текст' },
    { id: 's3', start: 8, end: 14, text: 'Последний текст' },
  ];
  const cues = subtitleCues(segments, { start: 5, end: 10, captionEdits: { s2: 'Исправленный текст' } });
  assert.deepEqual(cues, [
    { start: 0, end: 3, lines: ['Исправленный текст'], segmentId: 's2' },
    { start: 3, end: 5, lines: ['Последний текст'], segmentId: 's3' },
  ]);
  assert.match(subtitlesSrt(cues), /00:00:00,000 --> 00:00:03,000/);
  assert.match(subtitlesSrt(cues), /00:00:03,000 --> 00:00:05,000/);
});

test('edited ASS directives and newlines are visible text, never override scripts', () => {
  const hostile = '{\\pos(0,0)}Привет\\Nмир\nDialogue: 0,0,99';
  const escaped = escapeAss(hostile);
  assert.equal(escaped.includes('{'), false);
  assert.equal(escaped.includes('\\'), false);
  const cues = subtitleCues([{ id: 's1', start: 0, end: 4, text: hostile }], { start: 0, end: 4 });
  const ass = subtitlesAss(cues);
  assert.equal(ass.includes('{\\pos'), false);
  assert.equal(ass.split('\n').filter((line) => line.startsWith('Dialogue:')).length, 1);
});

test('phrase wrapping keeps at most two bounded lines and the full time range', () => {
  const text = 'Длинный русский текст для проверки читаемых субтитров без потери содержимого и корректного распределения времени между фразами. '.repeat(3);
  const cues = subtitleCues([{ id: 's1', start: 10, end: 30, text }], { start: 12, end: 25 });
  assert.ok(cues.length > 1);
  assert.equal(cues[0].start, 0);
  assert.equal(cues.at(-1).end, 13);
  assert.ok(cues.every((cue) => cue.lines.length <= 2 && cue.lines.every((line) => line.length <= 38)));
  assert.equal(cues.flatMap((cue) => cue.lines).join(' '), text.trim());
  assert.equal(subtitleCues([{ id: 's1', start: 0, end: 5, text: 'Скрыть' }], { start: 0, end: 5, captionEdits: { s1: '' } }).length, 0);
});

test('render revision follows edits, crop, and source but ignores selection state', () => {
  const source = { sha256: 'a'.repeat(64) };
  const clip = { id: 'c1', start: 0, end: 5, title: 'Заголовок', layout: 'fit', cropX: 0.5, captions: true };
  const segments = [{ id: 's1', start: 0, end: 5, text: 'Фраза' }];
  const revision = renderRevision(source, clip, segments);
  assert.equal(renderRevision(source, { ...clip, selected: true }, segments), revision);
  assert.notEqual(renderRevision(source, { ...clip, captionEdits: { s1: 'Правка' } }, segments), revision);
  assert.notEqual(renderRevision(source, { ...clip, cropX: 0.1 }, segments), revision);
  assert.notEqual(renderRevision({ sha256: 'b'.repeat(64) }, clip, segments), revision);
});
test('presentation keeps moving source branches and places escaped captions in their separate band', () => {
  const source = { width: 1920, height: 1080, sha256: 'a'.repeat(64) };
  const composition = { heading: { x: 100, y: 136, width: 1060, height: 128 },
    slide: { x: 420, y: 444, width: 1080, height: 430 }, speaker: { x: 104, y: 858, width: 216, height: 192 } };
  const clip = { layout: 'presentation', composition, start: 0, end: 5, title: 'Заголовок' };
  const args = videoFilterArgs(source, clip, true);
  assert.equal(args[0], '-filter_complex'); assert.deepEqual(args.slice(-2), ['-map', '[vout]']);
  assert.match(args[1], /^\[0:v:0\]split=3/);
  assert.match(args[1], /\[headingin\]crop=1060:128:100:136,scale=1000:180:/);
  assert.match(args[1], /pad=1080:780:0:0/);
  assert.match(args[1], /vstack=inputs=3:shortest=1,setsar=1,subtitles=captions.ass\[vout\]$/);
  assert.doesNotMatch(videoFilterArgs(source, { ...clip, captions: false }, true)[1], /subtitles=/);
  assert.doesNotMatch(videoFilterArgs(source, clip, false)[1], /subtitles=/);
  const cues = [{ start: 0, end: 5, lines: ['{\\pos(0,0)}Текст', 'Вторая строка'] }];
  const ass = subtitlesAss(cues, clip);
  assert.match(ass, /3,1,5,80,80,0,1/);
  assert.match(ass, /\{\\pos\(540,840\)\}\(\/pos\(0,0\)\)Текст\\NВторая строка/);
  assert.equal((ass.match(/\{\\pos/g) ?? []).length, 1);
  const revision = renderRevision(source, clip, []);
  assert.notEqual(renderRevision(source, { ...clip, composition: { ...composition, speaker: { ...composition.speaker, x: 106 } } }, []), revision);
  assert.equal(renderRevision(source, { ...clip, composition: { speaker: composition.speaker, heading: composition.heading, slide: composition.slide } }, []), revision);
  assert.throws(() => videoFilterArgs(source, { ...clip, composition: { ...composition, heading: { ...composition.heading, x: '0;movie=secret' } } }, true));
  const fit = { ...clip, layout: 'fit' }; const { composition: _, ...withoutComposition } = fit;
  assert.equal(renderRevision(source, fit, []), renderRevision(source, withoutComposition, []));
});

test('transcript cache validation rejects empty intervals, broken order and hallucination loops', () => {
  const segment = (start, end, text = 'Понятная русская фраза') => ({ start, end, text });
  assert.equal(transcriptProblem({ segments: [segment(0, 5)] }, 10), null);
  assert.match(transcriptProblem({ segments: [segment(5, 5)] }, 10), /границы/);
  assert.match(transcriptProblem({ segments: [segment(4, 5), segment(1, 2)] }, 10), /границы/);
  assert.match(transcriptProblem({ segments: [segment(0, 1), segment(1, 2), segment(2, 3)] }, 10), /зациклился/);
  assert.match(transcriptProblem({ segments: [segment(0, 1, '[BLANK_AUDIO]')] }, 10), /Речь не найдена/);
});

test('invalid derived cache is quarantined and one failed fresh attempt cannot poison retries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shorts-asr-retry-'));
  const output = path.join(root, 'transcript'); const source = path.join(root, 'video.mp4');
  const python = process.env.SHORTS_PYTHON; const ffmpeg = process.env.SHORTS_FFMPEG;
  try {
    await mkdir(output);
    await writeFile(source, 'source bytes stay unchanged');
    await writeFile(path.join(output, 'video.json'), '{broken');
    await writeFile(path.join(output, 'video.srt'), 'old derived subtitles');
    const fakePython = path.join(root, 'python-stub.mjs');
    await writeFile(fakePython, `#!${process.execPath}\n` + `
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// The bundled adapter must resolve independently of the caller's working directory.
// Reading it also catches a stale dependency on the former parent repository.
readFileSync(process.argv[2], 'utf8');
const output = process.argv[process.argv.indexOf('--output-dir') + 1];
const counter = path.join(path.dirname(output), 'attempts.txt');
let attempt = 0; try { attempt = Number(readFileSync(counter, 'utf8')); } catch {}
writeFileSync(counter, String(++attempt));
const data = { transcription: [{ offsets: { from: 0, to: attempt === 1 ? 0 : 5000 }, text: 'Настоящая расшифровка' }] };
for (const ext of ['json', 'srt', 'txt']) writeFileSync(path.join(output, 'video.' + ext), ext === 'json' ? JSON.stringify(data) : 'new derived content');
`, { mode: 0o700 });
    process.env.SHORTS_PYTHON = fakePython; process.env.SHORTS_FFMPEG = process.execPath;
    await assert.rejects(transcribe(source, output, { duration: 10 }), /неверный кеш повторно использоваться не будет/);
    assert.equal((await readdir(output)).includes('video.json'), false);
    const result = await transcribe(source, output, { duration: 10 });
    assert.equal(result.transcription[0].offsets.to, 5000);
    const quarantines = (await readdir(output)).filter((name) => name.startsWith('.invalid-asr-'));
    assert.equal(quarantines.length, 2);
    const archived = await Promise.all(quarantines.map((name) => readFile(path.join(output, name, 'video.json'), 'utf8')));
    assert.ok(archived.includes('{broken'));
    assert.equal(await readFile(source, 'utf8'), 'source bytes stay unchanged');
    await transcribe(source, output, { duration: 10 });
    assert.equal(await readFile(path.join(root, 'attempts.txt'), 'utf8'), '2');
    await transcribe(source, output, { duration: 10, force: true });
    assert.equal(await readFile(path.join(root, 'attempts.txt'), 'utf8'), '3');
  } finally {
    if (python === undefined) delete process.env.SHORTS_PYTHON; else process.env.SHORTS_PYTHON = python;
    if (ffmpeg === undefined) delete process.env.SHORTS_FFMPEG; else process.env.SHORTS_FFMPEG = ffmpeg;
    await rm(root, { recursive: true, force: true });
  }
});
