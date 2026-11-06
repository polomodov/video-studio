#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Studio } from './workflow.mjs';
import { startServer } from './server.mjs';
import { acquireLock, releaseOnExit } from './lock.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, port: { type: 'string', default: '4317' },
  source: { type: 'string' }, transcript: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });
const command = positionals[0] ?? 'serve';
const help = `Video Studio — шортсы: локальный отбор и монтаж\n\n  node src/cli.mjs serve [--port 4317] [--root /absolute/cache]\n  node src/cli.mjs import --source /absolute/video.mp4 [--transcript /absolute/whisper.json]\n  node src/cli.mjs analyze JOB_ID\n\nИмпорт запускает распознавание и Codex. Выбор и монтаж доступны в браузере.\nВидео и результаты хранятся локально; расшифровка передаётся Codex через вашу авторизацию.\n`;
try {
  if (values.help) { console.log(help); }
  else if (command === 'serve' || command === 'start') {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Неверный порт.');
    const { close, url } = await startServer({ root: values.root, port });
    console.log(`Video Studio / Shorts: ${url}\nОставьте это окно открытым. Остановка: Ctrl+C.`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (stopping) return; stopping = true; await close(); process.exit(0); });
  } else if (command === 'import' || command === 'analyze') {
    const studio = new Studio({ root: values.root });
    const release = await acquireLock(studio.store.root);
    const detach = releaseOnExit(release);
    try {
    let id;
    if (command === 'import') {
      const sourcePath = values.source ?? positionals[1];
      const job = await studio.importSource(sourcePath); id = job.id;
      if (values.transcript && !job.segments.length) await studio.attachTranscript(id, JSON.parse(await readFile(values.transcript, 'utf8')));
    } else { id = positionals[1]; }
    await studio.prepare(id, { analysisOnly: command === 'analyze' });
    console.log(`Выпуск: ${id}. Обработка запущена.`);
    const job = await studio.idle(id);
    if (job.error) throw new Error(job.error);
    console.log(`Готово: ${job.segments.length} реплик, ${job.candidates.length} кандидатов. Запустите serve для просмотра.`);
    } finally { detach(); await release(); }
  } else { throw new Error(help); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
