import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');

for (const scenario of [
  { name: 'mise tools', platform: 'Darwin', overrides: false },
  { name: 'mise with explicit media tools', platform: 'Darwin', overrides: true },
  { name: 'Linux local tools', platform: 'Linux', overrides: true },
]) test(`podcast launcher preserves caller directory and media-folder argument with ${scenario.name}`, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'podcast launcher '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  await mkdir(bin); await mkdir(home);
  const executable = (name, content) => writeFile(path.join(bin, name), content, { mode: 0o700 });
  await executable('uname', '#!/bin/sh\nprintf "%s\\n" "$TEST_PLATFORM"\n');
  await executable('node', `#!${process.execPath}\n` + `
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  ffmpeg: process.env.SHORTS_FFMPEG, ffprobe: process.env.SHORTS_FFPROBE,
  miseDirectory: process.env.TEST_MISE_DIRECTORY }));
`);
  await executable('mise', `#!${process.execPath}\n` + `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] !== '--cd' || args[2] !== 'exec' || args[3] !== '--') process.exit(2);
const result = spawnSync(args[4], args.slice(5), { cwd: args[1], stdio: 'inherit',
  env: { ...process.env, TEST_MISE_DIRECTORY: args[1] } });
process.exit(result.status ?? 1);
`);
  for (const name of ['ffmpeg', 'ffprobe']) await executable(name, '#!/bin/sh\nexit 0\n');
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, TEST_PLATFORM: scenario.platform };
  delete env.SHORTS_FFMPEG; delete env.SHORTS_FFPROBE; delete env.TEST_MISE_DIRECTORY;
  if (scenario.overrides) {
    env.SHORTS_FFMPEG = path.join(root, 'custom ffmpeg');
    env.SHORTS_FFPROBE = path.join(root, 'custom ffprobe');
  }
  const { stdout, stderr } = await exec('/bin/bash', [path.join(repository, 'start-podcast.command'), 'relative media folder'], {
    cwd: root, env, timeout: 10000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.cwd, root);
  assert.deepEqual(result.args, [path.join(repository, 'podcast/server.mjs'), 'relative media folder']);
  assert.equal(result.ffmpeg, scenario.overrides ? env.SHORTS_FFMPEG : path.join(bin, 'ffmpeg'));
  assert.equal(result.ffprobe, scenario.overrides ? env.SHORTS_FFPROBE : path.join(bin, 'ffprobe'));
  if (scenario.platform === 'Darwin') assert.equal(result.miseDirectory, repository);
  else {
    assert.equal(result.miseDirectory, undefined);
    assert.match(stderr, /macOS/);
  }
});
