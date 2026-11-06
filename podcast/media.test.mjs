import test from 'node:test';
import assert from 'node:assert/strict';
import { junction, validateClips } from './media.mjs';

const sources = new Map([
  ['camera.mp4', { name: 'camera.mp4', kind: 'video', duration: 60 }],
  ['voice.wav', { name: 'voice.wav', kind: 'audio', duration: 30 }],
]);
const clip = { video: 'camera.mp4', start: 10, end: 20, audio: 'voice.wav', audioStart: 5 };

test('clip validation preserves external audio offset and normalizes source audio', () => {
  assert.deepEqual(validateClips([clip], sources), [clip]);
  assert.deepEqual(validateClips([{ ...clip, audio: null, audioStart: 100 }], sources), [{ ...clip, audio: null, audioStart: 0 }]);
  assert.deepEqual(validateClips([], sources), []);
});

test('invalid video intervals and missing or overrun WAV are rejected', () => {
  for (const patch of [
    { video: 'voice.wav' }, { video: '../camera.mp4' }, { start: -1 }, { end: 61 },
    { end: 10 }, { end: 10.01 }, { start: NaN }, { end: Infinity },
    { audio: 'camera.mp4' }, { audio: 'missing.wav' }, { audioStart: -1 },
    { audioStart: 25 }, { audioStart: NaN },
  ]) assert.throws(() => validateClips([{ ...clip, ...patch }], sources));
  assert.throws(() => validateClips(Array(2001).fill(clip), sources), /2000/);
  assert.equal(validateClips([{ ...clip, end: clip.start + 1 / 30 }], sources).length, 1);
});

test('junction keeps up to four seconds on each side and advances the left WAV offset', () => {
  const right = { ...clip, start: 30, end: 45, audioStart: 10 };
  assert.deepEqual(junction([clip, right], 0), [
    { ...clip, start: 16, audioStart: 11 },
    { ...right, end: 34 },
  ]);
  const short = { ...clip, end: 12 };
  assert.deepEqual(junction([short, short], 0), [short, short]);
  for (const index of [-1, 1, 0.5, '0']) assert.throws(() => junction([clip, right], index));
  assert.equal(clip.start, 10);
});
