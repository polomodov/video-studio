import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorFrames, limitPlayback } from './ui/player.mjs';

function fixture({ native = true } = {}) {
  const video = new EventTarget();
  Object.assign(video, { videoWidth: 1920, videoHeight: 1080, readyState: 4, paused: true, ended: false });
  let next = 0; const callbacks = new Map(); const draws = [];
  const schedule = (fn) => { callbacks.set(++next, fn); return next; };
  const cancel = (id) => callbacks.delete(id);
  if (native) { video.requestVideoFrameCallback = schedule; video.cancelVideoFrameCallback = cancel; }
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => draws.push(args), clearRect: () => draws.push('clear') }) };
  const dispose = mirrorFrames(video, canvas, { raf: schedule, caf: cancel });
  return { video, canvas, draws, callbacks, dispose, emit: (name) => video.dispatchEvent(new Event(name)) };
}

test('paused seeks and new sources repaint decoded frames without restarting playback', () => {
  const f = fixture();
  assert.equal(f.draws.length, 1); assert.equal(f.canvas.width, 1280); assert.equal(f.canvas.height, 720);
  f.emit('seeked'); assert.equal(f.draws.length, 2); assert.equal(f.video.paused, true);
  assert.equal(f.callbacks.size, 0);
  f.emit('emptied'); assert.equal(f.draws.at(-1), 'clear');
  f.video.videoWidth = 1080; f.video.videoHeight = 1920; f.emit('loadeddata');
  assert.equal(f.canvas.width, 1080); assert.equal(f.canvas.height, 1920);
});

for (const native of [true, false]) test(`frame loop cancels on pause and disposal (native callbacks: ${native})`, () => {
  const f = fixture({ native });
  f.video.paused = false; f.emit('play'); f.emit('playing');
  assert.equal(f.callbacks.size, 1);
  const [id, callback] = f.callbacks.entries().next().value; f.callbacks.delete(id); callback();
  assert.equal(f.callbacks.size, 1);
  f.video.paused = true; f.emit('pause'); assert.equal(f.callbacks.size, 0);
  const count = f.draws.length;
  f.dispose(); f.emit('seeked'); assert.equal(f.draws.length, count);
});

test('no Canvas 2D leaves native playback available; unloaded video is not drawn', () => {
  assert.equal(mirrorFrames({}, { getContext: () => null }), null);
  const f = fixture(); f.video.readyState = 1; const count = f.draws.length;
  f.emit('seeked'); assert.equal(f.draws.length, count); f.dispose();
});

function rangeFixture() {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 10, paused: true, ended: false, seeking: false });
  let range = { start: 10, end: 15 }, serial = 0;
  const frames = new Map();
  video.pause = () => { video.paused = true; video.dispatchEvent(new Event('pause')); };
  const play = () => { video.paused = false; video.dispatchEvent(new Event('play')); };
  const guard = limitPlayback(video, () => range, { raf: fn => { frames.set(++serial, fn); return serial; }, caf: id => frames.delete(id) });
  const tick = () => { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(); };
  return { video, frames, guard, play, tick, setRange: value => { range = value; guard.update(); } };
}

test('native play stops exactly at selected end, and replay starts the clip again', () => {
  const f = rangeFixture(); f.play();
  f.video.currentTime = 15.12; f.tick();
  assert.equal(f.video.paused, true); assert.equal(f.video.currentTime, 15); assert.equal(f.frames.size, 0);
  f.play(); assert.equal(f.video.currentTime, 10); assert.equal(f.frames.size, 1);
  f.video.currentTime = 15.1; f.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.video.currentTime, 15); assert.equal(f.video.paused, true);
  f.guard.dispose();
});

test('draft end and context bounds remain live while paused seeks and manual pauses are preserved', () => {
  const f = rangeFixture(); f.video.currentTime = 12; f.play();
  f.setRange({ start: 10, end: 11.5 });
  assert.equal(f.video.currentTime, 11.5); assert.equal(f.video.paused, true);
  f.setRange({ start: 0, end: 25 }); f.video.currentTime = 0; f.play();
  f.video.currentTime = 15.2; f.tick(); assert.equal(f.video.paused, false);
  f.video.currentTime = 25.1; f.tick(); assert.equal(f.video.paused, true); assert.equal(f.video.currentTime, 25);
  f.video.currentTime = 40; f.video.dispatchEvent(new Event('seeked')); assert.equal(f.video.currentTime, 40);
  f.setRange({ start: 10, end: 15 }); f.play(); assert.equal(f.video.currentTime, 10);
  f.video.currentTime = 20; f.video.dispatchEvent(new Event('seeked'));
  assert.equal(f.video.paused, true); assert.equal(f.video.currentTime, 15);
  f.play(); f.video.pause(); assert.equal(f.frames.size, 0);
  f.guard.dispose();
});
