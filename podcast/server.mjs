import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { junction, probe, render, validateClips } from './media.mjs';
import { acquireLock } from '../src/lock.mjs';

export async function projectDirectory(directory) {
  const modern = join(directory, '.video-studio-montage');
  const legacy = join(directory, '.apollo-montage');
  async function exists(path) {
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error('Папка проекта должна быть обычным каталогом.');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const [hasModern, hasLegacy] = await Promise.all([exists(modern), exists(legacy)]);
  if (hasModern && hasLegacy) throw new Error('Найдены .video-studio-montage и .apollo-montage. Выберите нужный проект и переместите другой каталог из папки записи; автоматическое объединение не выполняется.');
  const output = hasLegacy ? legacy : modern;
  await mkdir(output, { mode: 0o700, recursive: true });
  if (!(await lstat(output)).isDirectory()) throw new Error('Папка проекта должна быть обычным каталогом.');
  return output;
}

export async function startPodcastServer({ directory: inputDirectory, port = 0, media = { probe, render } } = {}) {
const directory = await realpath(inputDirectory);
const output = await projectDirectory(directory);
const release = await acquireLock(output);
try {
const mime = new Map(Object.entries({
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.wav': 'audio/wav',
}));
const sources = new Map();
const warnings = [];
for (const item of await readdir(directory, { withFileTypes: true })) {
  if (!item.isFile() || !mime.has(extname(item.name).toLowerCase())) continue;
  const path = join(directory, item.name);
  try {
    sources.set(item.name, { name: item.name, path, ...await media.probe(path) });
  } catch (error) {
    warnings.push(`${item.name} — ${error.code === 'ENOENT' ? 'нужен ffprobe или файл недоступен' : 'не удалось прочитать медиа'}`);
  }
}

const projectPath = join(output, 'project.json');
const publicPath = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map(Object.entries({
  '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
}));
let origin;
let job;
let saving = false;
let rendering = Promise.resolve();

function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('Ожидается JSON.');
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Слишком большой запрос.');
  }
  return JSON.parse(body);
}

async function serveMedia(request, response, path, type) {
  const info = await lstat(path);
  if (!info.isFile() || !info.size) return json(response, 404, { error: 'Файл недоступен.' });
  const { size } = info;
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': type };
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (!match || !(match[1] || match[2]) || start >= size || start > end) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  response.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(path, { start, end });
  response.on('close', () => stream.destroy());
  stream.on('error', () => response.destroy()).pipe(response);
}

async function save(clips) {
  if (saving) throw new Error('Дождитесь завершения сохранения.');
  saving = true;
  try {
    const temp = await mkdtemp(join(output, '.save-'));
    try {
      const path = join(temp, 'project.json');
      await writeFile(path, JSON.stringify({ version: 1, clips }, null, 2) + '\n', { mode: 0o600 });
      await rename(path, projectPath);
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  } finally {
    saving = false;
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        (request.method === 'POST' && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
      return json(response, 403, { error: 'Доступ только из локального редактора.' });
    }
    const url = new URL(request.url, origin);
    const { pathname } = url;
    if (['GET', 'HEAD'].includes(request.method)) {
      if (assets.has(pathname)) {
        const [name, type] = assets.get(pathname);
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return response.end(request.method === 'HEAD' ? undefined : await readFile(join(publicPath, name)));
      }
      if (pathname === '/media') {
        const source = sources.get(url.searchParams.get('name'));
        if (source) return await serveMedia(request, response, source.path, mime.get(extname(source.name).toLowerCase()));
      }
      if (pathname === '/result') {
        const name = url.searchParams.get('name');
        if (/^\d{4}-\d\d-\d\dT[\d.-]+Z-(?:episode|junction)\.mp4$/.test(name ?? '')) {
          const path = join(output, name);
          if (url.searchParams.has('download')) response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          return await serveMedia(request, response, path, 'video/mp4');
        }
      }
      if (pathname === '/api/project') {
        let project;
        let projectError;
        try {
          if (!(await lstat(projectPath)).isFile()) throw new Error('Файл проекта должен быть обычным файлом.');
          project = JSON.parse(await readFile(projectPath, 'utf8'));
          if (project.version !== 1 || !Array.isArray(project.clips) || !project.clips.every(clip =>
            typeof clip?.video === 'string' && Number.isFinite(clip.start) && Number.isFinite(clip.end) &&
            (clip.audio === null || typeof clip.audio === 'string') && Number.isFinite(clip.audioStart))) {
            throw new Error('Неизвестный формат проекта.');
          }
          try { validateClips(project.clips, sources); } catch (error) { projectError = error.message; }
        } catch (error) {
          project = null;
          if (error.code !== 'ENOENT') projectError = error.message;
        }
        return json(response, 200, {
          title: basename(directory), sources: [...sources.values()].map(({ path, ...source }) => source),
          warnings, projectError, clips: project?.clips ?? [],
        });
      }
      if (pathname === '/api/job') return json(response, 200, job ?? { state: 'idle' });
    }
    if (request.method === 'POST' && ['/api/project', '/api/render'].includes(pathname)) {
      const body = await readBody(request);
      const clips = validateClips(body.clips, sources);
      if (pathname === '/api/project') {
        await save(clips);
        return json(response, 200, { clips });
      }
      if (!clips.length) throw new Error('Добавьте хотя бы один клип.');
      if (job?.state === 'running') throw new Error('Дождитесь окончания текущего рендера.');
      const preview = body.junction !== undefined;
      const selection = preview ? junction(clips, body.junction) : clips;
      const current = { state: 'running', fraction: 0, label: 'Подготовка', preview };
      job = current;
      rendering = media.render(selection, sources, output, preview, (fraction, label) => {
        current.fraction = Math.max(current.fraction, fraction);
        current.label = label;
      }).then(name => Object.assign(current, { state: 'done', fraction: 1, name }),
        error => Object.assign(current, { state: 'failed', error: error.message }));
      return json(response, 202, current);
    }
    return json(response, 404, { error: 'Ресурс не найден.' });
  } catch (error) {
    if (response.headersSent) return response.destroy();
    return json(response, error.code === 'ENOENT' ? 404 : (error.status ?? 400), { error: error.message });
  }
});

server.requestTimeout = 120000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;
let closing;
const close = () => closing ??= (async () => {
  await new Promise((resolve) => server.close(resolve));
  await rendering;
  await release();
})();
server.once('close', () => { rendering.finally(release).catch(() => {}); });
return { server, close, url: origin, directory, output };
} catch (error) { await release(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Запуск: node podcast/server.mjs "/путь/к/папке записи"');
    process.exitCode = 1;
  } else {
    try {
      const running = await startPodcastServer({ directory: process.argv[2] });
      console.log(`Video Studio · монтаж подкаста · ${running.url}`);
      console.log(`Проект и MP4: ${running.output}`);
      console.log('Остановка: Ctrl+C. Текущий рендер завершится перед выходом.');
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
        if (stopping) return;
        stopping = true;
        await running.close();
        process.exit(0);
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
