import path from 'node:path';
import { readFile, rename } from 'node:fs/promises';
import { Store, AppError, MAX_CANDIDATES, atomicJSON, normalizeSegments, validateProposals, editCandidate, selectedForRender, verifySource, requireThat } from './core.mjs';
import * as defaultMedia from './media.mjs';
import { selectWithCodex } from './codex.mjs';

export class Studio {
  constructor({ root, media = defaultMedia, select = selectWithCodex } = {}) {
    this.store = new Store(root); this.media = media; this.select = select;
    this.pending = new Map(); this.queue = Promise.resolve();
  }
  async importSource(sourcePath) {
    const job = await this.store.importSource(sourcePath, this.media.probeMedia);
    try { await this.media.createPoster(job.source.path, path.join(this.store.dir(job.id), 'poster.jpg')); }
    catch { /* A playable source is sufficient even if a poster fails. */ }
    return job;
  }
  async attachTranscript(id, raw, { engine = 'imported' } = {}) {
    requireThat(['imported', 'whisper.cpp'].includes(engine), 'Неизвестный источник расшифровки.');
    const job = await this.store.get(id);
    requireThat(!job.candidates.length, 'У выпуска уже есть кандидаты. Сохранённые решения не заменены.', 409);
    await verifySource(job.source);
    const segments = normalizeSegments(raw, job.source.duration);
    await atomicJSON(path.join(this.store.dir(id), 'transcript.raw.json'), raw);
    return this.store.update(id, (current) => {
      current.segments = segments;
      current.transcription = { engine, sourceSha256: job.source.sha256, createdAt: new Date().toISOString() };
      current.error = null; current.progress = 'Расшифровка готова'; current.status = 'imported';
    });
  }
  enqueue(id, initial, work) {
    requireThat(!this.pending.has(id), 'Этот выпуск уже обрабатывается.', 409);
    const initialization = this.store.update(id, initial);
    const operation = this.queue.then(() => initialization).then(work).catch(async (error) => {
      await this.store.update(id, (job) => {
        job.status = job.candidates.length ? 'ready' : 'error';
        job.error = error.message || 'Обработка не завершена.';
        job.progress = 'Требуется повторная попытка';
        for (const clip of job.candidates) if (['queued', 'rendering'].includes(clip.renderStatus)) {
          clip.renderStatus = 'error'; clip.renderError = job.error;
        }
      });
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, operation); this.queue = operation.catch(() => {});
    return initialization;
  }
  progress(id) {
    let last = 0;
    return (value) => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      this.store.update(id, (job) => { job.progress = String(value); }).catch(() => {});
    };
  }
  async prepare(id, { analysisOnly = false } = {}) {
    const job = await this.store.get(id);
    if (job.candidates.length && job.segments.length) return job;
    requireThat(!analysisOnly || job.segments.length > 0, 'Сначала нужна расшифровка.');
    return this.enqueue(id, (current) => {
      current.status = current.segments.length ? 'analyzing' : 'transcribing';
      current.progress = 'В очереди обработки'; current.error = null;
    }, async () => {
      let current = await this.store.get(id);
      await verifySource(current.source);
      if (!current.segments.length) {
        let raw;
        let engine = current.transcription?.engine ?? 'imported';
        const rawFile = path.join(this.store.dir(id), 'transcript.raw.json');
        try {
          raw = JSON.parse(await readFile(rawFile, 'utf8'));
          normalizeSegments(raw, current.source.duration);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            if (!(error instanceof SyntaxError) && !(error instanceof AppError)) throw error;
            await rename(rawFile, `${rawFile}.invalid-${Date.now()}`);
          }
          raw = null;
        }
        if (!raw) {
          raw = await this.media.transcribe(current.source.path, path.join(this.store.dir(id), 'transcript'), { onProgress: this.progress(id), duration: current.source.duration });
          engine = 'whisper.cpp';
        }
        await this.attachTranscript(id, raw, { engine });
      }
      await this.store.update(id, (saved) => { saved.status = 'analyzing'; saved.progress = 'Codex выбирает законченные мысли'; });
      current = await this.store.get(id);
      const proposals = await this.select(current, this.store.dir(id));
      const candidates = validateProposals(proposals, current.segments, current.source.duration);
      await this.store.update(id, (saved) => {
        saved.candidates = candidates; saved.status = 'ready'; saved.error = null;
        saved.progress = `${candidates.length} фрагментов готовы к просмотру`;
        saved.analysis = { engine: 'codex-cli', createdAt: new Date().toISOString(), transcriptSource: saved.transcription.sourceSha256 };
      });
    });
  }
  async expand(id, targetCount) {
    requireThat(Number.isInteger(targetCount) && targetCount >= 1 && targetCount <= MAX_CANDIDATES, `Укажите общее число историй от 1 до ${MAX_CANDIDATES}.`);
    const job = await this.store.get(id);
    requireThat(job.segments.length > 0, 'Сначала нужна расшифровка.');
    if (job.candidates.length >= targetCount) return job;
    requireThat(!job.candidates.some(c => ['queued', 'rendering'].includes(c.renderStatus)), 'Дождитесь окончания сборки.', 409);
    return this.enqueue(id, current => { current.status = 'analyzing'; current.progress = 'Ищем дополнительные истории'; current.error = null; }, async () => {
      const current = await this.store.get(id);
      await verifySource(current.source);
      const count = targetCount - current.candidates.length;
      const proposals = await this.select(current, this.store.dir(id), { count, exclude: current.candidates.map(({ start, end, title }) => ({ start, end, title })) });
      const candidates = validateProposals(proposals, current.segments, current.source.duration);
      requireThat(candidates.length <= count, 'Отбор вернул больше историй, чем запрошено.');
      await this.store.update(id, saved => {
        requireThat(saved.candidates.length + candidates.length <= targetCount, 'Список кандидатов изменился во время отбора. Повторите запрос.', 409);
        const seen = [...saved.candidates];
        let index = Math.max(0, ...seen.map(c => Number(c.id.replace('clip-', '')) || 0));
        const additions = candidates.map(candidate => {
          requireThat(!seen.some(c => c.start < candidate.end && candidate.start < c.end), 'Дополнительные истории пересекаются с текущим отбором. Повторите запрос.');
          const next = { ...candidate, id: `clip-${String(++index).padStart(2, '0')}` };
          seen.push(next); return next;
        });
        saved.candidates.push(...additions);
        saved.status = 'ready'; saved.error = null; saved.progress = `${saved.candidates.length} фрагментов готовы к просмотру`;
      });
    });
  }
  async edit(id, candidateId, patch) {
    return this.store.update(id, (job) => {
      const index = job.candidates.findIndex((clip) => clip.id === candidateId);
      requireThat(index >= 0, 'Фрагмент не найден.', 404);
      job.candidates[index] = editCandidate(job.candidates[index], patch, job);
    });
  }
  async render(id, ids) {
    let job, clips;
    return this.enqueue(id, (current) => {
      // Selection and the exact render snapshot must be read under the same write lock.
      clips = selectedForRender(current, ids).map((clip) => structuredClone(clip));
      job = structuredClone(current);
      for (const clip of current.candidates) if (ids.includes(clip.id)) {
        clip.renderStatus = 'queued'; clip.renderError = null;
      }
      current.progress = 'Ролики в очереди сборки'; current.error = null;
    }, async () => {
      await verifySource(job.source);
      for (const clip of clips) {
        await this.store.update(id, (current) => {
          current.candidates.find((item) => item.id === clip.id).renderStatus = 'rendering';
          current.progress = `Собирается «${clip.title}»`;
        });
        try {
          const result = await this.media.renderClip({ source: job.source, clip, segments: job.segments,
            outputDir: path.join(this.store.dir(id), 'exports'), onProgress: this.progress(id) });
          const files = [result.videoFile, result.srtFile, result.descriptionFile];
          requireThat(files.every((name) => typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..')), 'Некорректный путь результата.');
          await this.store.update(id, (current) => {
            const saved = current.candidates.find((item) => item.id === clip.id);
            saved.renderStatus = 'ready'; saved.renderError = null;
            saved.export = { ...result, createdAt: new Date().toISOString(),
              videoUrl: `/media/${id}/exports/${result.videoFile}`,
              srtUrl: `/media/${id}/exports/${result.srtFile}`,
              descriptionUrl: `/media/${id}/exports/${result.descriptionFile}` };
          });
        } catch (error) {
          await this.store.update(id, (current) => {
            const saved = current.candidates.find((item) => item.id === clip.id);
            saved.renderStatus = 'error'; saved.renderError = error.message;
          });
        }
      }
      await this.store.update(id, (current) => { current.progress = 'Сборка завершена. Проверьте готовые ролики.'; });
    });
  }
  async idle(id) { await this.pending.get(id); return this.store.get(id); }
}
