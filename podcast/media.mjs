import { spawn, execFile } from 'node:child_process';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findTool } from '../src/media.mjs';

const exec = promisify(execFile);
const fps = 30;
const inputOptions = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav',
];

export async function probe(path) {
  const { stdout } = await exec(await findTool('ffprobe'), [
    '-v', 'error', ...inputOptions, '-show_format', '-show_streams', '-of', 'json', path,
  ], { timeout: 20_000 });
  const { streams, format } = JSON.parse(stdout);
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const duration = Number((video ?? audio)?.duration ?? format.duration);
  if ((!video && !audio) || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Не удалось определить длительность.');
  }
  return {
    kind: video ? 'video' : 'audio',
    video: video?.index,
    audio: audio?.index,
    duration,
    details: video ? `${video.width}×${video.height} · ${video.codec_name}` : `${audio.channels} кан. · ${audio.sample_rate} Гц`,
  };
}

function quantize(seconds) {
  return Math.round(seconds * fps) / fps;
}

export function validateClips(value, sources) {
  if (!Array.isArray(value) || value.length > 2000) throw new Error('Ожидается список до 2000 клипов.');
  return value.map((clip, index) => {
    const invalid = message => { throw new Error(`Клип ${index + 1}. ${message}`); };
    if (!clip || typeof clip !== 'object') invalid('Некорректный формат.');
    const video = sources.get(clip.video);
    const audio = sources.get(clip.audio);
    if (video?.kind !== 'video') invalid('Видео недоступно.');
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) ||
        clip.start < 0 || clip.end > video.duration + 0.001 || clip.end - clip.start < 1 / fps - 0.000001) {
      invalid('Проверьте вход и выход. Минимальная длина — один кадр (1/30 с).');
    }
    if (clip.audio !== null && (
      audio?.kind !== 'audio' || !Number.isFinite(clip.audioStart) || clip.audioStart < 0 ||
      clip.audioStart + clip.end - clip.start > audio.duration + 0.001
    )) invalid('Внешний звук недоступен или его диапазон выходит за границы файла.');
    return {
      video: video.name,
      start: clip.start,
      end: clip.end,
      audio: audio?.name ?? null,
      audioStart: audio ? clip.audioStart : 0,
    };
  });
}

export function junction(clips, index) {
  if (!Number.isInteger(index) || !clips[index] || !clips[index + 1]) {
    throw new Error('Выберите клип, после которого есть стык.');
  }
  const [left, right] = clips.slice(index, index + 2);
  const start = Math.max(left.start, left.end - 4);
  return [
    { ...left, start, audioStart: left.audioStart + start - left.start },
    { ...right, end: Math.min(right.end, right.start + 4) },
  ];
}

async function ffmpeg(args, report) {
  const binary = await findTool('ffmpeg');
  return new Promise((resolve, reject) => {
    const process = spawn(binary, ['-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    let buffer = '';
    process.stderr.setEncoding('utf8').on('data', data => { errors = (errors + data).slice(-6000); });
    process.stdout.setEncoding('utf8').on('data', data => {
      const lines = (buffer + data).split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) report(Number(line.slice(12)) / 1e6);
      }
    });
    process.on('error', reject);
    process.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(errors.trim() || `FFmpeg завершился с кодом ${code}.`));
    });
  });
}

export async function render(clips, sources, output, preview, report) {
  const work = await mkdtemp(join(output, '.render-'));
  const file = preview ? 'junction.mp4' : 'episode.mp4';
  const result = join(work, file);
  const [width, height] = preview ? [960, 540] : [1920, 1080];
  const durations = clips.map(clip => quantize(clip.end - clip.start));
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  let rendered = 0;
  const concat = [];
  try {
    for (const [index, clip] of clips.entries()) {
      const video = sources.get(clip.video);
      const audio = sources.get(clip.audio);
      const duration = durations[index];
      const name = `segment-${index}.mov`;
      const input = ['-ss', String(clip.start), ...inputOptions, '-i', video.path];
      let audioStream = `0:${video.audio}`;
      if (audio) {
        input.push('-ss', String(clip.audioStart), ...inputOptions, '-i', audio.path);
        audioStream = `1:${audio.audio}`;
      } else if (video.audio === undefined) {
        input.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
        audioStream = '1:a:0';
      }

      const videoFilter = [
        `fps=${fps}:start_time=0`,
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        'tpad=stop_mode=clone:stop_duration=0.2',
      ].join(',');
      await ffmpeg([
        ...input, '-map', `0:${video.video}`, '-map', audioStream, '-map_metadata', '-1', '-map_chapters', '-1',
        '-t', duration.toFixed(8), '-vf', videoFilter, '-af', 'aresample=48000:async=1:first_pts=0,apad',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
        '-video_track_timescale', '30000', '-write_tmcd', '0', '-c:a', 'pcm_s16le', '-ac', '2',
        join(work, name),
      ], seconds => report((rendered + Math.min(seconds, duration)) / total * 0.94, `Клип ${index + 1} из ${clips.length}`));
      concat.push(`file ${name}\nduration ${duration.toFixed(8)}\n`);
      rendered += duration;
    }
    await writeFile(join(work, 'clips.ffconcat'), concat.join(''));
    await ffmpeg([
      '-f', 'concat', '-safe', '1', '-i', join(work, 'clips.ffconcat'),
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', result,
    ], seconds => report(0.94 + Math.min(seconds / total, 1) * 0.05, 'Сборка MP4'));

    // Each completed render gets a unique name. A hard link publishes it without replacing a file.
    const basename = `${new Date().toISOString().replaceAll(':', '-')}-${file}`;
    await link(result, join(output, basename));
    return basename;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
