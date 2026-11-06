#!/usr/bin/env node
// Reproducible integration check: real media/server/render, synthetic transcript
// and deterministic candidate selector. This does not validate Whisper or Codex.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Studio } from '../src/workflow.mjs';
import { startServer } from '../src/server.mjs';
import { findTool } from '../src/media.mjs';

const execute = promisify(execFile);
const run = (binary, args) => execute(binary, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
const ffmpeg = await findTool('ffmpeg');
const ffprobe = await findTool('ffprobe');
const root = await mkdtemp(path.join(os.tmpdir(), 'shorts-studio-smoke-'));
const source = path.join(root, 'synthetic.mp4');
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=8',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
const studio = new Studio({ root, select: async (job) => ({ candidates: [{
  startSegmentId: job.segments[0].id, endSegmentId: job.segments[1].id,
  title: 'Synthetic caption check', reason: 'Deterministic test fixture', contextRisk: '',
}] }) });
const imported = await studio.importSource(source);
await studio.attachTranscript(imported.id, { segments: [
  { start: 0, end: 4, text: 'Первая тестовая подпись' },
  { start: 4, end: 8, text: 'Вторая тестовая подпись' },
] });
const { url, close } = await startServer({ studio, port: 0 });
const request = async (route, method = 'GET', data) => {
  const response = await fetch(url + route, { method, ...(data === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }) });
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response;
};
try {
  assert.match(await (await request('/')).text(), /Video Studio/);
  await request(`/api/jobs/${imported.id}/analyze`, 'POST', {});
  let job = await studio.idle(imported.id);
  assert.equal(job.error, null);
  const candidate = job.candidates[0];
  assert.equal(candidate.selected, false);
  // HTTP editing and explicit selection precede the render.
  await request(`/api/jobs/${job.id}/candidates/${candidate.id}`, 'PATCH', {
    selected: true, start: 1, end: 7, title: 'Synthetic caption check', captions: true,
  });
  await request(`/api/jobs/${job.id}/render`, 'POST', { candidateIds: [candidate.id] });
  job = await studio.idle(job.id);
  const clip = job.candidates[0];
  assert.equal(clip.renderStatus, 'ready', clip.renderError);
  const srt = await (await request(clip.export.srtUrl)).text();
  assert.match(srt, /00:00:00,000 --> 00:00:03,000/);
  assert.match(srt, /00:00:03,000 --> 00:00:06,000/);
  assert.match(srt, /Первая тестовая подпись/);
  assert.match(srt, /Вторая тестовая подпись/);
  const video = path.join(root, 'verified.mp4');
  await writeFile(video, Buffer.from(await (await request(clip.export.videoUrl)).arrayBuffer()));
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]);
  const metadata = JSON.parse(stdout);
  const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(videoStream.width, 1080); assert.equal(videoStream.height, 1920);
  assert.equal(videoStream.codec_name, 'h264'); assert.equal(audioStream?.codec_name, 'aac');
  assert.ok(Math.abs(Number(metadata.format.duration) - 6) < 0.15);
  await run(ffmpeg, ['-v', 'error', '-xerror', '-i', video, '-f', 'null', '-']);
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', video, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const volume = /mean_volume: ([\d.-]+) dB/.exec(stderr);
  assert.ok(volume && Number(volume[1]) > -60, 'Export audio must not be silent');
  for (const second of [1, 4]) await run(ffmpeg, ['-v', 'error', '-y', '-ss', String(second), '-i', video,
    '-frames:v', '1', path.join(root, `caption-${second}.png`)]);
  const summary = { fixture: 'synthetic; no ASR or Codex', root, jobId: job.id, video,
    width: videoStream.width, height: videoStream.height, duration: Number(metadata.format.duration),
    videoCodec: videoStream.codec_name, audioCodec: audioStream.codec_name, meanVolumeDb: Number(volume[1]),
    captions: ['0–3 s', '3–6 s'], frames: [1, 4].map((second) => path.join(root, `caption-${second}.png`)) };
  await writeFile(path.join(root, 'validation.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { await close(); }
