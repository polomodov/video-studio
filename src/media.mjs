import { subtitleCues } from './ui/captions.mjs';
export { subtitleCues } from './ui/captions.mjs';
import { compositeLayout, renderPlan } from './ui/composition.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, validateComposition } from './core.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheBin = path.join(DEFAULT_ROOT, 'bin');

async function executable(filename) {
  try { await access(filename, constants.X_OK); return filename; } catch { return null; }
}

export async function findTool(name, { optional = false } = {}) {
  const override = process.env[`SHORTS_${name.toUpperCase()}`];
  const names = name === 'python' ? ['python3', 'python'] : [name];
  const candidates = override ? [override] : [
    ...names.map((item) => path.join(cacheBin, item)),
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
      .flatMap((folder) => names.map((item) => path.join(folder, item))),
  ];
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  if (optional && !override) return null;
  throw new Error(`Не найден ${name}. Установите инструмент или задайте SHORTS_${name.toUpperCase()} с абсолютным путём.`);
}

function run(command, args, { cwd, env = process.env, onLine, allowedCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let pendingOut = ''; let pendingErr = '';
    function collect(chunk, stream) {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + text).slice(-8 * 1024 * 1024);
      else stderr = (stderr + text).slice(-512 * 1024);
      let pending = (stream === 'stdout' ? pendingOut : pendingErr) + text;
      const lines = pending.split(/[\r\n]+/); pending = lines.pop();
      for (const line of lines) if (line) onLine?.(line);
      if (stream === 'stdout') pendingOut = pending; else pendingErr = pending;
    }
    child.stdout.on('data', (data) => collect(data, 'stdout'));
    child.stderr.on('data', (data) => collect(data, 'stderr'));
    child.on('error', (error) => reject(new Error(`Не удалось запустить ${path.basename(command)}: ${error.message}`)));
    child.on('close', (code) => {
      if (pendingOut) onLine?.(pendingOut);
      if (pendingErr) onLine?.(pendingErr);
      if (allowedCodes.includes(code)) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} завершился с кодом ${code}: ${stderr.slice(-2500) || stdout.slice(-1000)}`));
    });
  });
}

function frameRate(value) {
  const [a, b = '1'] = String(value ?? '0').split('/').map(Number);
  const rate = a / Number(b);
  return Number.isFinite(rate) && rate > 0 ? rate : 30;
}

export async function probeMedia(sourcePath) {
  const source = path.resolve(sourcePath);
  const probe = await findTool('ffprobe', { optional: true });
  if (probe) {
    const { stdout } = await run(probe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source]);
    const data = JSON.parse(stdout);
    const video = data.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const duration = Number(data.format?.duration ?? video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || !(video.width > 0 && video.height > 0)) {
      throw new Error('В файле не найдена видеодорожка с корректной длительностью.');
    }
    return { duration, width: video.width, height: video.height, fps: frameRate(video.avg_frame_rate || video.r_frame_rate), hasAudio: data.streams.some((stream) => stream.codec_type === 'audio') };
  }
  const ffmpeg = await findTool('ffmpeg');
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', source], { allowedCodes: [1] });
  const time = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const video = stderr.split('\n').find((line) => /Stream .*Video:/.test(line));
  const size = video?.match(/\b(\d{2,5})x(\d{2,5})\b/);
  if (!time || !size) throw new Error('FFmpeg не смог прочитать размер и длительность видео.');
  return { duration: Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]), width: Number(size[1]), height: Number(size[2]), fps: frameRate(video.match(/([\d.]+) fps/)?.[1]), hasAudio: /Stream .*Audio:/.test(stderr) };
}

export async function createPoster(sourcePath, destination) {
  const ffmpeg = await findTool('ffmpeg');
  const { duration } = await probeMedia(sourcePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(Math.min(5, duration / 2)), '-i', path.resolve(sourcePath), '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', path.resolve(destination)]);
  return destination;
}

export function transcriptProblem(raw, duration) {
  const entries = raw?.transcription ?? raw?.segments;
  if (!Array.isArray(entries)) return 'В расшифровке нет реплик.';
  let previous = -1; let previousText = ''; let repeats = 0; let spoken = 0;
  for (const item of entries) {
    const text = String(item?.text ?? '').trim();
    if (!text || /^\[(?:BLANK_AUDIO|Silence)\]$/i.test(text)) continue;
    const start = item.offsets ? item.offsets.from / 1000 : item.start;
    const end = item.offsets ? item.offsets.to / 1000 : item.end;
    if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && start < duration && end <= duration + 2 && start >= previous)) return 'Расшифровка содержит неверные временные границы.';
    previous = start; spoken += 1;
    const normalized = text.toLocaleLowerCase('ru').replace(/\s+/g, ' ');
    repeats = normalized === previousText ? repeats + 1 : 1;
    if (repeats >= 3 && normalized.length >= 12) return 'Whisper зациклился на повторении одной фразы.';
    previousText = normalized;
  }
  return spoken ? null : 'Речь не найдена. Проверьте звуковую дорожку.';
}

async function quarantineTranscript(destination, stem, reason) {
  const files = [];
  for (const extension of ['.json', '.srt', '.txt']) {
    const file = path.join(destination, `${stem}${extension}`);
    try { await stat(file); files.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!files.length) return null;
  const quarantine = await mkdtemp(path.join(destination, '.invalid-asr-'));
  await writeFile(path.join(quarantine, 'reason.json'), `${JSON.stringify({ reason, createdAt: new Date().toISOString(), files: files.map((file) => path.basename(file)) }, null, 2)}\n`);
  for (const file of files) await rename(file, path.join(quarantine, path.basename(file)));
  return quarantine;
}

export async function transcribe(sourcePath, outputDir, { onProgress, force = false, duration } = {}) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(outputDir);
  const stem = path.parse(source).name;
  const jsonPath = path.join(destination, `${stem}.json`);
  const mediaDuration = duration ?? (await probeMedia(source)).duration;
  if (!(Number.isFinite(mediaDuration) && mediaDuration > 0)) throw new Error('Для расшифровки нужна корректная длительность исходника.');
  let cacheProblem = 'Неполный результат предыдущей расшифровки.';
  try {
    const cached = JSON.parse(await readFile(jsonPath, 'utf8'));
    cacheProblem = force ? 'Запрошено повторное распознавание.' : transcriptProblem(cached, mediaDuration);
    if (!cacheProblem) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) cacheProblem = 'Повреждён JSON предыдущей расшифровки.';
  }
  await mkdir(destination, { recursive: true });
  const quarantined = await quarantineTranscript(destination, stem, cacheProblem);
  if (quarantined) onProgress?.('Предыдущая расшифровка сохранена отдельно; запускаю повторное распознавание.');
  const python = await findTool('python');
  const ffmpeg = await findTool('ffmpeg');
  const toolDir = await mkdtemp(path.join(destination, '.tools-'));
  onProgress?.('Локальная расшифровка Whisper…');
  try {
    // The transcription wrapper discovers the literal command name "ffmpeg". A link
    // also supports SHORTS_FFMPEG overrides whose executable has another name.
    await symlink(path.resolve(ffmpeg), path.join(toolDir, 'ffmpeg'));
    await run(python, [
      path.join(repoRoot, 'scripts', 'transcribe_media.py'),
      source, '--output-dir', destination, '--backend', 'auto', '--language', 'ru', '--max-context', '0',
    ], {
      env: { ...process.env, PATH: `${toolDir}${path.delimiter}${process.env.PATH ?? ''}` },
      onLine: (line) => {
        const progress = line.match(/progress\s*=\s*(\d+)%/);
        if (progress) onProgress?.(`Расшифровка: ${progress[1]}%`);
        else if (/retrying with CPU/.test(line)) onProgress?.('Whisper повторяет распознавание на CPU.');
      },
    });
  } finally { await rm(toolDir, { recursive: true, force: true }); }
  let data; let problem;
  try { data = JSON.parse(await readFile(jsonPath, 'utf8')); problem = transcriptProblem(data, mediaDuration); }
  catch (error) { problem = `Не удалось прочитать результат Whisper: ${error.message}`; }
  if (problem) {
    await quarantineTranscript(destination, stem, problem);
    throw new Error(`${problem} Результат сохранён отдельно. Повторите распознавание; неверный кеш повторно использоваться не будет.`);
  }
  onProgress?.('Расшифровка готова.');
  return data;
}

function plainText(value) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); }

// ASS interprets braces and backslashes as commands. Use ordinary visible
// punctuation so edits cannot become override scripts or missing-font glyphs.
export function escapeAss(value) {
  return plainText(value).replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')');
}

function timestamp(seconds, format) {
  const precision = format === 'ass' ? 100 : 1000;
  let units = Math.max(0, Math.round(seconds * precision));
  const hours = Math.floor(units / (3600 * precision)); units %= 3600 * precision;
  const minutes = Math.floor(units / (60 * precision)); units %= 60 * precision;
  const whole = Math.floor(units / precision); const fraction = units % precision;
  return `${format === 'ass' ? hours : String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}${format === 'ass' ? '.' : ','}${String(fraction).padStart(format === 'ass' ? 2 : 3, '0')}`;
}

export function subtitlesSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start, 'srt')} --> ${timestamp(cue.end, 'srt')}\n${cue.lines.join('\n')}`).join('\n\n') + (cues.length ? '\n' : '');
}

export function subtitlesAss(cues, { layout = 'fit' } = {}) {
  const presentation = compositeLayout(layout);
  const captionY = layout === 'duo' ? 960 : layout === 'slide-speaker' ? 930 : 840;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,${presentation ? 5 : 2},80,80,${presentation ? 0 : 240},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map((cue) => `Dialogue: 0,${timestamp(cue.start, 'ass')},${timestamp(cue.end, 'ass')},Default,,0,0,0,,${presentation ? `{\\pos(540,${captionY})}` : ''}${cue.lines.map(escapeAss).join('\\N')}`).join('\n') + '\n';
}

export function renderRevision(source, clip, segments) {
  return createHash('sha256').update(JSON.stringify({
    version: 1, source: source.sha256 ?? { path: source.path, bytes: source.bytes, mtimeMs: source.mtimeMs },
    start: clip.start, end: clip.end, title: plainText(clip.title), layout: clip.layout ?? 'fit',
    cropX: clip.cropX ?? 0.5, captions: clip.captions !== false, cues: subtitleCues(segments, clip),
    ...(compositeLayout(clip.layout) ? { ...(clip.layout === 'presentation' ? { presentationVersion: 2 } : { compositionVersion: 1 }), composition: validateComposition(clip.composition, source, clip.layout) } : {}),
  })).digest('hex').slice(0, 12);
}

export function videoFilterArgs(source, clip, hasCues) {
  const layout = clip.layout ?? 'fit'; const cropX = clip.cropX ?? 0.5;
  if (!['fit', 'crop', 'presentation', 'duo', 'slide-speaker'].includes(layout) || !(Number.isFinite(cropX) && cropX >= 0 && cropX <= 1)) throw new Error('Некорректное кадрирование.');
  const composition = layout === 'presentation' || clip.composition !== undefined ? validateComposition(clip.composition, source, compositeLayout(layout) ? layout : undefined) : null;
  const subtitles = clip.captions !== false && hasCues ? ',subtitles=captions.ass' : '';
  if (['duo', 'slide-speaker'].includes(layout)) {
    const { blocks } = renderPlan(source, clip);
    const graph = [`[0:v:0]split=${blocks.length}${blocks.map((_, i) => `[in${i}]`).join('')}`];
    blocks.forEach((block, i) => {
      const r = block.encode?.input ?? block.source, t = block.target;
      const sizing = block.encode
        ? `scale=${block.encode.scaled.width}:${block.encode.scaled.height},crop=${t.width}:${t.height}:${block.encode.offset.x}:${block.encode.offset.y}`
        : `scale=${t.width}:${t.height}`;
      graph.push(`[in${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},${sizing},pad=1080:${block.height}:${t.x}:${t.y}:color=${block.background.replace('#', '0x')},setsar=1[tile${i}]`);
    });
    graph.push(`${blocks.map((_, i) => `[tile${i}]`).join('')}vstack=inputs=${blocks.length}:shortest=1,setsar=1${subtitles}[vout]`);
    return ['-filter_complex', graph.join(';'), '-map', '[vout]'];
  }
  if (layout === 'presentation') {
    const crop = (rect) => `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`;
    const contain = (height, color, width = 1080) => `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:${height}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1`;
    const graph = [
      '[0:v:0]split=3[headingin][slidein][speakerin]',
      `[headingin]${crop(composition.heading)},${contain(180, '0x151913', 1000)}[heading]`,
      `[slidein]${crop(composition.slide)},${contain(540, '0x161a22')},pad=1080:780:0:0:color=0x161a22[slide]`,
      `[speakerin]${crop(composition.speaker)},scale=1080:960:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:960:(iw-ow)/2:(ih-oh)/2,setsar=1[speaker]`,
      `[heading][slide][speaker]vstack=inputs=3:shortest=1,setsar=1${subtitles}[vout]`,
    ].join(';');
    return ['-filter_complex', graph, '-map', '[vout]'];
  }
  const sizing = layout === 'crop'
    ? `scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920:(iw-ow)*${cropX}:(ih-oh)/2`
    : 'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x101820';
  return ['-map', '0:v:0', '-vf', `${sizing},setsar=1${subtitles}`];
}

export async function renderClip({ source, clip, segments, outputDir, onProgress }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(clip.id ?? '')) throw new Error('Некорректный идентификатор ролика.');
  if (!(Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0 && clip.end > clip.start && clip.end <= source.duration)) throw new Error('Границы ролика должны находиться внутри исходного видео.');
  const cues = subtitleCues(segments, clip);
  const videoFilters = videoFilterArgs(source, clip, cues.length > 0);
  const ffmpeg = await findTool('ffmpeg');
  const output = path.resolve(outputDir); await mkdir(output, { recursive: true });
  const revision = renderRevision(source, clip, segments);
  const base = `${clip.id}-${revision}`;
  const result = { videoFile: `${base}.mp4`, srtFile: `${base}.srt`, descriptionFile: `${base}.txt`, revision };
  const staging = await mkdtemp(path.join(output, '.render-'));
  try {
    await writeFile(path.join(staging, result.srtFile), subtitlesSrt(cues));
    await writeFile(path.join(staging, 'captions.ass'), subtitlesAss(cues, clip));
    await writeFile(path.join(staging, result.descriptionFile), `${plainText(clip.title)}\n\nФрагмент выпуска «${plainText(source.name ?? path.basename(source.path))}».\nИсходный диапазон: ${timestamp(clip.start, 'srt')} — ${timestamp(clip.end, 'srt')}.\n\nПеред публикацией проверьте субтитры, название и описание.\n`);
    const duration = clip.end - clip.start; let lastProgress = -1;
    onProgress?.('Монтаж: 0%');
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(clip.start), '-i', path.resolve(source.path), '-t', String(duration),
      ...videoFilters, '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      ...(source.hasAudio === false ? [] : ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000']),
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', path.join(staging, result.videoFile),
    ], { cwd: staging, onLine: (line) => {
      const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
      if (!match) return;
      const progress = Math.max(0, Math.min(99, Math.round(Number(match[1]) / 1e6 / duration * 100)));
      if (progress !== lastProgress) { lastProgress = progress; onProgress?.(`Монтаж: ${progress}%`); }
    } });
    const rendered = await probeMedia(path.join(staging, result.videoFile));
    if (rendered.width !== 1080 || rendered.height !== 1920 || Math.abs(rendered.duration - duration) > Math.max(0.2, 2 / (source.fps || 30))) throw new Error('Проверка готового ролика не прошла: размер или длительность отличаются от задания.');
    if (source.hasAudio && !rendered.hasAudio) throw new Error('Проверка готового ролика не прошла: отсутствует исходная аудиодорожка.');
    if ((await stat(path.join(staging, result.videoFile))).size === 0) throw new Error('FFmpeg создал пустой файл.');
    for (const key of ['srtFile', 'descriptionFile', 'videoFile']) await rename(path.join(staging, result[key]), path.join(output, result[key]));
    onProgress?.('Монтаж: 100%');
    return result;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
