#!/usr/bin/env node
// Real local HTTP, FFmpeg, persistence, and export check using generated media only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { findTool } from '../src/media.mjs';
import { startPodcastServer } from '../podcast/server.mjs';

const execute = promisify(execFile);
const run = (binary, args, options = {}) => execute(binary, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
const ffmpeg = await findTool('ffmpeg');
const ffprobe = await findTool('ffprobe');
const directory = await mkdtemp(path.join(tmpdir(), 'video-studio-podcast-smoke-'));
const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
for (const [index, rate] of [25, 60].entries()) {
  await run(ffmpeg, [...base, '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}:duration=9`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(directory, `camera-${index + 1}.mp4`)]);
}
for (const [index, frequency] of [440, 880].entries()) {
  await run(ffmpeg, [...base, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=12`,
    '-c:a', 'pcm_s16le', path.join(directory, `voice-${index + 1}.wav`)]);
}
const clips = [
  { video: 'camera-1.mp4', start: 1.11, end: 6.13, audio: 'voice-1.wav', audioStart: 2.25 },
  { video: 'camera-2.mp4', start: 2.02, end: 7.04, audio: 'voice-2.wav', audioStart: 3.5 },
];
let running = await startPodcastServer({ directory });
const request = async (route, { method = 'GET', body, headers = {}, expected = 200 } = {}) => {
  const response = await fetch(running.url + route, { method, headers: { Origin: running.url,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${route}: ${await response.clone().text()}`);
  return response;
};
const post = (route, body, expected = 200) => request(route, { method: 'POST', body, expected });
async function waitForRender() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const job = await (await request('/api/job')).json();
    if (job.state === 'done') return job;
    assert.notEqual(job.state, 'failed', job.error);
    await delay(100);
  }
  throw new Error('Podcast render timed out after two minutes');
}

async function audioSample(file, second, expectedFrequency) {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-ss', String(second), '-i', file,
    '-t', '1', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { encoding: 'buffer' });
  assert.ok(stdout.length >= 15000, 'At least 0.9375s of audio must be decoded');
  let crossings = 0, energy = 0, previous = 0;
  for (let index = 0; index < stdout.length - 1; index += 2) {
    const value = stdout.readInt16LE(index) / 32768;
    if (previous <= 0 && value > 0) crossings++;
    energy += value * value; previous = value;
  }
  const duration = stdout.length / 2 / 8000;
  const frequency = crossings / duration;
  const rms = Math.sqrt(energy / (stdout.length / 2));
  assert.ok(rms > 0.01, 'Export audio must be audible');
  assert.ok(Math.abs(frequency - expectedFrequency) < 20, `Expected ${expectedFrequency}Hz, got ${frequency}Hz`);
  return { second, frequency, rms };
}

async function verify(file, width, height, expectedDuration, boundary) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(audio.codec_name, 'aac');
  assert.equal(video.width, width); assert.equal(video.height, height); assert.equal(video.avg_frame_rate, '30/1');
  assert.ok(Math.abs(Number(data.format.duration) - expectedDuration) < 0.1, 'Duration must follow frame-quantized clips');
  await run(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  const audioChecks = [await audioSample(file, 1, 440), await audioSample(file, boundary + 1, 880)];
  return { file, width, height, fps: 30, duration: Number(data.format.duration), audioChecks, fullDecode: true };
}

try {
  assert.match(await (await request('/')).text(), /VIDEO STUDIO/);
  const initial = await (await request('/api/project')).json();
  assert.equal(initial.sources.length, 4); assert.deepEqual(initial.warnings, []);
  await post('/api/project', { clips });
  await running.close();
  running = await startPodcastServer({ directory });
  assert.deepEqual((await (await request('/api/project')).json()).clips, clips);
  const projectFile = path.join(running.output, 'project.json');
  const saved = await readFile(projectFile, 'utf8');
  await post('/api/project', { clips: [{ ...clips[0], audioStart: 11 }] }, 400);
  await request('/api/project', { method: 'POST', body: { clips: [] }, headers: { Origin: 'https://example.invalid' }, expected: 403 });
  assert.equal(await readFile(projectFile, 'utf8'), saved);
  const range = await request('/media?name=voice-1.wav', { headers: { Range: 'bytes=0-31' }, expected: 206 });
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  await request('/media?name=voice-1.wav', { headers: { Range: 'bytes=999999999-' }, expected: 416 });
  await post('/api/render', { clips, junction: 0 }, 202);
  await post('/api/render', { clips }, 400);
  const junction = await waitForRender();
  const junctionFile = path.join(running.output, junction.name);
  const preview = await verify(junctionFile, 960, 540, 8, 4);
  await post('/api/render', { clips }, 202);
  const episode = await waitForRender();
  const episodeFile = path.join(running.output, episode.name);
  const boundary = Math.round((clips[0].end - clips[0].start) * 30) / 30;
  const total = clips.reduce((sum, clip) => sum + Math.round((clip.end - clip.start) * 30) / 30, 0);
  const full = await verify(episodeFile, 1920, 1080, total, boundary);
  const download = await request(`/result?name=${encodeURIComponent(episode.name)}&download`, { method: 'HEAD' });
  assert.match(download.headers.get('content-disposition'), /attachment/);
  for (const second of [1, boundary + 1]) await run(ffmpeg, [...base, '-ss', String(second), '-i', episodeFile,
    '-frames:v', '1', path.join(directory, `frame-${Math.round(second)}.jpg`)]);
  const summary = { fixture: 'generated test patterns at 25/60fps and WAV tones at 440/880Hz; no real media',
    directory, output: running.output, persistedClips: clips.length,
    rejected: ['out-of-bounds WAV', 'foreign origin', 'invalid byte range', 'concurrent render'], preview, full };
  await writeFile(path.join(directory, 'validation.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { await running.close(); }
