import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, requireThat, verifySource } from './core.mjs';
import { Studio } from './workflow.mjs';
import { acquireLock } from './lock.mjs';
import { LayoutTemplateStore } from './layout-templates.mjs';

const UI = fileURLToPath(new URL('./ui/', import.meta.url));
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/player.mjs', ['player.mjs', 'text/javascript; charset=utf-8']], ...['composition.mjs', 'composition-editor.mjs', 'captions.mjs'].map((name) => [`/${name}`, [name, 'text/javascript; charset=utf-8']]), ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const json = (res, data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
async function body(req) {
  requireThat(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 'Ожидался JSON.', 415);
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 2 * 1024 * 1024, 'Запрос слишком большой.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw new AppError('Не удалось прочитать JSON.'); }
}
export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  requireThat(match && (match[1] || match[2]), 'Неверный диапазон.', 416);
  let start, end;
  if (!match[1]) { const count = Number(match[2]); requireThat(count > 0 && Number.isSafeInteger(count), 'Неверный диапазон.', 416); start = Math.max(0, size - count); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  requireThat(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start < size, 'Неверный диапазон.', 416);
  return { start, end };
}
function exportDisposition(candidate, filename) {
  const extension = path.extname(filename);
  let title = String(candidate.title ?? '').toWellFormed().normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Leave room for the extension on filesystems with a 255-byte filename limit.
  const characters = Array.from(title);
  while (Buffer.byteLength(characters.join(''), 'utf8') > 220) characters.pop();
  title = characters.join('').replace(/[. ]+$/g, '');
  if (!title || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = 'Фрагмент';
  const encoded = encodeURIComponent(`${title}${extension}`).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  // Inline keeps the video player working; download links use filename* as the saved name.
  return `inline; filename="${filename}"; filename*=UTF-8''${encoded}`;
}
async function streamFile(req, res, file, type, disposition) {
  const info = await stat(file);
  requireThat(info.isFile(), 'Файл не найден.', 404);
  let range;
  try { range = byteRange(req.headers.range, info.size); }
  catch (error) { res.setHeader('Content-Range', `bytes */${info.size}`); throw error; }
  const start = range?.start ?? 0, end = range?.end ?? info.size - 1;
  res.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(disposition ? { 'Content-Disposition': disposition } : {}),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
export async function startServer({ root, port = 4317, studio = new Studio({ root }) } = {}) {
  const release = await acquireLock(studio.store.root);
  const layoutTemplates = new LayoutTemplateStore(studio.store.root);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const actualPort = server.address().port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      requireThat(hosts.includes(req.headers.host), 'Недопустимый Host.', 403);
      requireThat(!req.headers.origin || hosts.some((host) => req.headers.origin === `http://${host}`), 'Запрос с другого сайта отклонён.', 403);
      requireThat(req.headers['sec-fetch-site'] !== 'cross-site', 'Запрос с другого сайта отклонён.', 403);
      const url = new URL(req.url, `http://${hosts[0]}`);
      const route = decodeURIComponent(url.pathname);
      if (STATIC.has(route) && ['GET', 'HEAD'].includes(req.method)) {
        const [name, type] = STATIC.get(route);
        const content = await readFile(path.join(UI, name));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (route === '/api/layout-templates') {
        if (req.method === 'GET') return json(res, { templates: await layoutTemplates.list() });
        if (req.method === 'POST') {
          const { template, created } = await layoutTemplates.create(await body(req));
          return json(res, { template }, created ? 201 : 200);
        }
      }
      if (route === '/api/jobs') {
        if (req.method === 'GET') return json(res, { jobs: await studio.store.list() });
        if (req.method === 'POST') {
          const input = await body(req);
          const job = await studio.importSource(input.sourcePath);
          return json(res, await studio.prepare(job.id), 202);
        }
      }
      const match = /^\/api\/jobs\/([a-f0-9]{16})(?:\/(prepare|analyze|render|candidates)(?:\/([a-z0-9-]+))?)?$/.exec(route);
      if (match) {
        const [, id, action, clipId] = match;
        if (!action && req.method === 'GET') return json(res, await studio.store.get(id));
        if (['prepare', 'analyze'].includes(action) && req.method === 'POST' && !clipId) {
          const input = await body(req);
          if (action === 'analyze' && input.targetCount !== undefined) return json(res, await studio.expand(id, input.targetCount), 202);
          return json(res, await studio.prepare(id, { analysisOnly: action === 'analyze' }), 202);
        }
        if (action === 'render' && req.method === 'POST' && !clipId) return json(res, await studio.render(id, (await body(req)).candidateIds), 202);
        if (action === 'candidates' && req.method === 'PATCH' && clipId) return json(res, await studio.edit(id, clipId, await body(req)));
      }
      const media = /^\/media\/([a-f0-9]{16})\/(source|poster|exports\/([a-zA-Z0-9_.-]+))$/.exec(route);
      if (media && ['GET', 'HEAD'].includes(req.method)) {
        const [, id, kind, filename] = media;
        const job = await studio.store.get(id);
        if (kind === 'source') {
          await verifySource(job.source);
          const ext = path.extname(job.source.path).toLowerCase();
          return await streamFile(req, res, job.source.path, ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4');
        }
        if (kind === 'poster') return await streamFile(req, res, path.join(studio.store.dir(id), 'poster.jpg'), 'image/jpeg');
        const candidate = job.candidates.find((clip) => clip.export && [clip.export.videoFile, clip.export.srtFile, clip.export.descriptionFile].includes(filename));
        requireThat(!filename.includes('..') && candidate, 'Файл не найден.', 404);
        const type = filename.endsWith('.mp4') ? 'video/mp4' : 'text/plain; charset=utf-8';
        return await streamFile(req, res, path.join(studio.store.dir(id), 'exports', filename), type, exportDisposition(candidate, filename));
      }
      throw new AppError('Маршрут не найден.', 404);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      json(res, { error: error.code === 'ENOENT' ? 'Файл не найден.' : error.message || 'Ошибка обработки.' }, error.status ?? (error.code === 'ENOENT' ? 404 : 500));
    }
  });
  server.requestTimeout = 120000;
  try {
    await studio.store.recover();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { server.close(); await release(); throw error; }
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await studio.queue;
    await release();
  };
  server.once('close', () => { studio.queue.finally(release).catch(() => {}); });
  return { server, studio, close, url: `http://127.0.0.1:${server.address().port}` };
}
