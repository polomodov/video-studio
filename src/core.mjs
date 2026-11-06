import { validateRegions, compositeLayout } from './ui/composition.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MAX_CANDIDATES = 15;
export const DEFAULT_ROOT = path.join(homedir(), '.cache', 'shorts-studio');
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const requireThat = (condition, message, status = 400) => {
  if (!condition) throw new AppError(message, status);
};
export const readJSON = async (file) => JSON.parse(await readFile(file, 'utf8'));
export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function normalizeSegments(raw, duration) {
  const entries = raw.transcription ?? raw.segments;
  requireThat(Array.isArray(entries), 'В расшифровке нет реплик.');
  const segments = entries.map((item) => ({
    start: item.offsets ? item.offsets.from / 1000 : item.start,
    end: item.offsets ? item.offsets.to / 1000 : item.end,
    text: String(item.text ?? '').trim(),
  })).filter((item) => item.text && !/^\[(?:BLANK_AUDIO|Silence)\]$/i.test(item.text));
  requireThat(segments.length > 0, 'Речь не найдена. Проверьте звуковую дорожку.');
  let previous = -1;
  return segments.map((item, i) => {
    requireThat(Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 &&
      item.end > item.start && item.start < duration && item.end <= duration + 2 && item.start >= previous,
    'Расшифровка содержит неверные временные границы.');
    previous = item.start;
    return { id: `s${String(i + 1).padStart(5, '0')}`, ...item, end: Math.min(duration, item.end) };
  });
}
const textField = (value, name, limit) => {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= limit,
    `Некорректное поле «${name}».`);
  return value.trim();
};
export function validateProposals(response, segments, duration) {
  requireThat(Array.isArray(response?.candidates) && response.candidates.length > 0 && response.candidates.length <= MAX_CANDIDATES,
    'Codex не вернул допустимый список фрагментов. Попробуйте повторить отбор.');
  const indices = new Map(segments.map((segment, index) => [segment.id, index]));
  const seen = new Set();
  return response.candidates.map((item, index) => {
    const from = indices.get(item.startSegmentId), to = indices.get(item.endSegmentId);
    requireThat(from !== undefined && to !== undefined && to >= from, 'Codex сослался на неизвестные реплики.');
    const start = segments[from].start, end = segments[to].end;
    requireThat(start >= 0 && end <= duration && end - start >= 5 && end - start <= 180,
      'Предложенный фрагмент должен длиться от 5 до 180 секунд.');
    const key = `${from}:${to}`;
    requireThat(!seen.has(key), 'Codex предложил повторяющиеся фрагменты.');
    seen.add(key);
    const caution = item.contextRisk ?? '';
    requireThat(typeof caution === 'string' && caution.length <= 1200, 'Неверное описание контекста.');
    return {
      id: `clip-${String(index + 1).padStart(2, '0')}`,
      title: textField(item.title, 'заголовок', 200),
      reason: textField(item.reason, 'причина выбора', 1200),
      caution, hook: segments[from].text,
      startSegmentId: item.startSegmentId, endSegmentId: item.endSegmentId, start, end,
      selected: false, layout: 'fit', cropX: 0.5, captions: true, captionEdits: {},
      renderStatus: 'idle', renderError: null, export: null,
    };
  });
}
export function validateComposition(composition, source, layout) {
  try { return validateRegions(composition, source, layout); }
  catch (error) { throw new AppError(error.message); }
}
export function editCandidate(candidate, patch, job) {
  requireThat(patch && typeof patch === 'object' && !Array.isArray(patch), 'Ожидался объект правок.');
  const allowed = new Set(['selected', 'start', 'end', 'title', 'layout', 'cropX', 'composition', 'captions', 'captionEdits']);
  requireThat(Object.keys(patch).every((key) => allowed.has(key)), 'В запросе есть неизвестные поля.');
  requireThat(!['queued', 'rendering'].includes(candidate.renderStatus), 'Дождитесь окончания сборки этого ролика.', 409);
  const next = { ...candidate, ...patch };
  requireThat(typeof next.selected === 'boolean' && typeof next.captions === 'boolean', 'Неверное значение переключателя.');
  requireThat(Number.isFinite(next.start) && Number.isFinite(next.end) && next.start >= 0 && next.end <= job.source.duration &&
    next.end - next.start >= 5 && next.end - next.start <= 180, 'Фрагмент должен быть внутри выпуска и длиться от 5 до 180 секунд.');
  requireThat(['fit', 'crop', 'presentation', 'duo', 'slide-speaker'].includes(next.layout), 'Выберите способ кадрирования.');
  if (compositeLayout(next.layout) || next.composition !== undefined) next.composition = validateComposition(next.composition, job.source, compositeLayout(next.layout) ? next.layout : undefined);
  requireThat(Number.isFinite(next.cropX) && next.cropX >= 0 && next.cropX <= 1, 'Неверное положение кадра.');
  next.title = textField(next.title, 'заголовок', 200);
  requireThat(next.captionEdits && typeof next.captionEdits === 'object' && !Array.isArray(next.captionEdits), 'Неверные правки субтитров.');
  const ids = new Set(job.segments.map((segment) => segment.id));
  requireThat(Object.entries(next.captionEdits).every(([key, value]) => ids.has(key) && typeof value === 'string' && value.length <= 2000),
    'Правки субтитров должны ссылаться на существующие реплики.');
  const changed = [...allowed].filter((key) => key !== 'selected').some((key) => JSON.stringify(candidate[key]) !== JSON.stringify(next[key]));
  if (changed) {
    next.export = null;
    next.renderStatus = candidate.export ? 'stale' : 'idle';
    next.renderError = null;
  }
  return next;
}
export function selectedForRender(job, ids) {
  requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_CANDIDATES && new Set(ids).size === ids.length, 'Выберите фрагменты для сборки.');
  return ids.map((id) => {
    const candidate = job.candidates.find((item) => item.id === id);
    requireThat(candidate?.selected === true, 'Собрать можно только выбранные вами фрагменты.');
    requireThat(!['queued', 'rendering'].includes(candidate.renderStatus), 'Этот фрагмент уже собирается.', 409);
    return candidate;
  });
}
export async function verifySource(source) {
  let current;
  try { current = await stat(source.path); } catch { throw new AppError('Исходный файл не найден. Верните его на место или импортируйте заново.', 409); }
  requireThat(current.isFile() && current.size === source.bytes && current.mtimeMs === source.mtimeMs,
    'Исходный файл изменился. Импортируйте обновлённое видео как новый выпуск.', 409);
}

export class Store {
  constructor(root = DEFAULT_ROOT) { this.root = path.resolve(root); this.locks = new Map(); }
  dir(id) {
    requireThat(/^[a-f0-9]{16}$/.test(id), 'Выпуск не найден.', 404);
    return path.join(this.root, 'jobs', id);
  }
  async get(id) {
    try { return await readJSON(path.join(this.dir(id), 'job.json')); }
    catch (error) { if (error.code === 'ENOENT') throw new AppError('Выпуск не найден.', 404); throw error; }
  }
  async update(id, update) {
    const before = this.locks.get(id) ?? Promise.resolve();
    const operation = before.catch(() => {}).then(async () => {
      const job = await this.get(id);
      const result = await update(job) ?? job;
      result.updatedAt = new Date().toISOString();
      await atomicJSON(path.join(this.dir(id), 'job.json'), result);
      return result;
    });
    this.locks.set(id, operation);
    try { return await operation; } finally { if (this.locks.get(id) === operation) this.locks.delete(id); }
  }
  async list() {
    let dirs;
    try { dirs = await readdir(path.join(this.root, 'jobs')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const jobs = [];
    for (const id of dirs.filter((item) => /^[a-f0-9]{16}$/.test(item))) {
      const job = await this.get(id);
      jobs.push({ id, title: job.title, source: job.source, status: job.status, progress: job.progress,
        error: job.error, updatedAt: job.updatedAt, candidateCount: job.candidates.length,
        selectedCount: job.candidates.filter((candidate) => candidate.selected).length });
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async importSource(input, probe) {
    requireThat(typeof input === 'string' && path.isAbsolute(input), 'Укажите полный путь к локальному видео.');
    let sourcePath, info;
    try { sourcePath = await realpath(input); info = await stat(sourcePath); }
    catch { throw new AppError('Файл не найден. Проверьте путь.'); }
    requireThat(info.isFile() && info.size > 0 && /\.(mp4|mov|m4v|mkv|webm)$/i.test(sourcePath), 'Нужен непустой видеофайл MP4, MOV, MKV или WebM.');
    const metadata = await probe(sourcePath);
    requireThat(Number.isFinite(metadata.duration) && metadata.duration > 5 && metadata.width > 0 && metadata.height > 0, 'Не удалось прочитать параметры видео.');
    requireThat(metadata.hasAudio, 'В видео нет звуковой дорожки.');
    const sha256 = await hashFile(sourcePath), id = sha256.slice(0, 16);
    const afterHash = await stat(sourcePath);
    requireThat(afterHash.size === info.size && afterHash.mtimeMs === info.mtimeMs, 'Файл изменился во время импорта. Повторите попытку.', 409);
    let existing;
    try { existing = await this.get(id); } catch (error) { if (error.status !== 404) throw error; }
    if (existing) return this.update(id, (job) => {
      // Byte-identical moves/copies keep editorial decisions and repair the source reference.
      job.source = { ...metadata, path: sourcePath, name: path.basename(sourcePath), bytes: info.size, mtimeMs: info.mtimeMs, sha256 };
    });
    const now = new Date().toISOString();
    const job = { version: 1, id, title: path.basename(sourcePath, path.extname(sourcePath)),
      source: { ...metadata, path: sourcePath, name: path.basename(sourcePath), bytes: info.size, mtimeMs: info.mtimeMs, sha256 },
      createdAt: now, updatedAt: now, status: 'imported', progress: 'Файл добавлен', error: null,
      segments: [], candidates: [], transcription: null, analysis: null };
    await atomicJSON(path.join(this.dir(id), 'job.json'), job);
    return job;
  }
  async recover() {
    for (const item of await this.list()) {
      await this.update(item.id, (job) => {
        if (['transcribing', 'analyzing'].includes(job.status)) {
          job.status = 'error'; job.error = 'Обработка была прервана. Нажмите «Повторить».';
        }
        for (const clip of job.candidates) if (['queued', 'rendering'].includes(clip.renderStatus)) {
          clip.renderStatus = 'error'; clip.renderError = 'Сборка была прервана. Её можно повторить.';
        }
      });
    }
  }
}
