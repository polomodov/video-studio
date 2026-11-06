const get = id => document.getElementById(id);
const player = get('player');
const audio = get('audio');
const source = get('source');
const sound = get('sound');
const sources = new Map();
let clips = [];
let selected = -1;
let activeVideo;
let activeAudio;
let playRange;
let dirty = false;
let formDirty = false;
let busy = false;

function time(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = value => String(value).padStart(2, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
}

function seconds(value) {
  const normalized = value.trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  if (!/^(?:\d+:)?[0-5]?\d:[0-5]\d(?:\.\d+)?$/.test(normalized)) return NaN;
  return normalized.split(':').reduce((sum, item) => sum * 60 + Number(item), 0);
}

function message(text, error = false) {
  const element = get('message');
  element.hidden = !text;
  element.textContent = text;
  element.toggleAttribute('data-error', error);
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function action(id, handler) {
  get(id).onclick = async () => {
    try { await handler(); } catch (error) { message(error.message, true); }
  };
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function seek(target) {
  const duration = sources.get(activeVideo)?.duration;
  if (!Number.isFinite(target) || target < 0 || target > duration + 0.001) {
    throw new Error('Введите таймкод в пределах исходника, например 01:12:45.500.');
  }
  player.currentTime = Math.min(target, duration);
}

function loadVideo(name, position) {
  const media = sources.get(name);
  if (!media) return;
  player.pause();
  playRange = undefined;
  player.onloadedmetadata = null;
  if (activeVideo !== name || player.readyState === 0) {
    activeVideo = name;
    player.onloadedmetadata = () => seek(position);
    player.src = `/media?name=${encodeURIComponent(name)}`;
  } else {
    seek(position);
  }
  get('seek').value = time(position);
  get('source-info').textContent = `${time(media.duration)} · ${media.details}`;
}

function syncSound(force = false) {
  if (!activeAudio) return;
  const target = seconds(get('audio-in').value) + player.currentTime - seconds(get('in').value);
  if (!Number.isFinite(target) || target < 0 || target >= audio.duration || audio.readyState === 0) {
    audio.pause();
    return;
  }
  if (force || Math.abs(target - audio.currentTime) > 0.13) audio.currentTime = target;
  audio.playbackRate = player.playbackRate;
  if (player.paused || player.seeking) audio.pause();
  else audio.play().catch(() => {});
}

function selectSound() {
  const name = sound.value;
  get('audio-field').hidden = !name;
  player.muted = Boolean(name);
  if (activeAudio !== name) {
    audio.pause();
    activeAudio = name;
    if (name) audio.src = `/media?name=${encodeURIComponent(name)}`;
    else {
      audio.removeAttribute('src');
      audio.load();
    }
  }
  syncSound(true);
}

function fill(index, position) {
  selected = index;
  const clip = clips[index];
  source.value = clip?.video ?? activeVideo ?? source.options[0]?.value ?? '';
  sound.value = clip?.audio ?? '';
  const duration = sources.get(source.value)?.duration;
  get('in').value = time(clip?.start ?? 0);
  get('out').value = time(clip?.end ?? duration);
  get('audio-in').value = time(clip?.audioStart ?? 0);
  get('inspector-title').textContent = clip ? `Клип ${index + 1}` : 'Новый клип';
  get('apply').textContent = clip ? 'Применить к клипу' : 'Добавить в сборку';
  get('split').disabled = !clip;
  get('apply').disabled = !duration;
  get('play-range').disabled = !duration;
  loadVideo(source.value, position ?? clip?.start ?? 0);
  selectSound();
  formDirty = false;
  drawClips();
}

function readClip() {
  const video = sources.get(source.value);
  const start = seconds(get('in').value);
  const end = seconds(get('out').value);
  const audioStart = sound.value ? seconds(get('audio-in').value) : 0;
  if (!video || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 ||
      end > video.duration + 0.001 || end - start < 1 / 30 - 0.000001) {
    throw new Error('Проверьте вход и выход. Минимальная длина — один кадр (1/30 с).');
  }
  const audioMedia = sources.get(sound.value);
  if (sound.value && (!audioMedia || !Number.isFinite(audioStart) || audioStart < 0 ||
      audioStart + end - start > audioMedia.duration + 0.001)) {
    throw new Error('Выбранный диапазон выходит за границы внешнего WAV.');
  }
  return { video: video.name, start, end: Math.min(end, video.duration), audio: sound.value || null, audioStart };
}

function acceptForm() {
  const clip = readClip();
  if (selected < 0) selected = clips.length;
  clips[selected] = clip;
  dirty = true;
  fill(selected);
  message('Клип в сборке.');
}

function rowButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = handler;
  return button;
}

function discardForm() {
  return !formDirty || confirm('Отбросить изменения в форме клипа?');
}

function drawClips() {
  const list = get('clips');
  list.replaceChildren();
  let offset = 0;
  for (const [index, clip] of clips.entries()) {
    const row = document.createElement('li');
    row.classList.toggle('selected', index === selected);
    const choose = rowButton('', () => { if (discardForm()) fill(index); });
    choose.className = 'clip-name';
    choose.setAttribute('aria-pressed', String(index === selected));
    const name = document.createElement('strong');
    name.textContent = `${index + 1}. ${clip.video}`;
    const detail = document.createElement('span');
    detail.className = 'clip-time';
    detail.textContent = `В выпуске ${time(offset)} · Исходник ${time(clip.start)} → ${time(clip.end)} · ${clip.audio ? `${clip.audio} с ${time(clip.audioStart)}` : 'звук камеры'}`;
    choose.append(name, detail);
    offset += Math.round((clip.end - clip.start) * 30) / 30;
    const move = direction => {
      if (!discardForm()) return;
      const next = index + direction;
      [clips[index], clips[next]] = [clips[next], clips[index]];
      dirty = true;
      fill(next);
    };
    const up = rowButton('↑', () => move(-1));
    up.setAttribute('aria-label', 'Поднять клип');
    up.disabled = index === 0;
    const down = rowButton('↓', () => move(1));
    down.setAttribute('aria-label', 'Опустить клип');
    down.disabled = index === clips.length - 1;
    const cut = rowButton('Стык →', () => startRender(index).catch(error => message(error.message, true)));
    cut.disabled = busy || index === clips.length - 1;
    row.append(choose, up, down, cut, rowButton('Удалить', () => {
      if (!discardForm()) return;
      clips.splice(index, 1);
      dirty = true;
      fill(Math.min(index, clips.length - 1));
    }));
    list.append(row);
  }
  get('total').textContent = `${clips.length} кл. · ${time(offset)}`;
  get('empty').hidden = clips.length > 0;
  get('export').disabled = !clips.length || busy;
}

function showJob(job) {
  if (job.state === 'idle') return;
  busy = job.state === 'running';
  get('job').hidden = false;
  get('job-title').textContent = job.preview ? 'Превью стыка' : 'Экспорт полного выпуска';
  get('progress').value = job.fraction;
  get('job-status').textContent = job.state === 'failed' ? job.error :
    job.state === 'done' ? 'Готово' : `${job.label} · ${Math.floor(job.fraction * 100)}%`;
  const result = get('result');
  const download = get('download');
  result.hidden = !job.preview || job.state !== 'done';
  download.hidden = job.state !== 'done';
  if (job.state === 'done') {
    const url = `/result?name=${encodeURIComponent(job.name)}`;
    if (job.preview) result.src = url;
    download.href = `${url}&download=1`;
  } else if (result.hasAttribute('src')) {
    result.removeAttribute('src');
    result.load();
  }
  if (busy) setTimeout(poll, 850);
  else drawClips();
}

async function poll() {
  try { showJob(await api('/api/job')); } catch (error) {
    busy = false;
    drawClips();
    message(error.message, true);
  }
}

async function startRender(junction) {
  if (formDirty) throw new Error('Примените изменения клипа перед рендером.');
  if (busy) return;
  const job = await api('/api/render', { clips, junction });
  showJob(job);
  drawClips();
  get('job').scrollIntoView({ block: 'nearest' });
}

source.onchange = () => {
  const duration = sources.get(source.value).duration;
  if (selected < 0) {
    get('in').value = time(0);
    get('out').value = time(duration);
  }
  loadVideo(source.value, Math.min(seconds(get('in').value) || 0, duration));
  formDirty = true;
};
sound.onchange = () => { formDirty = true; selectSound(); };
for (const field of ['in', 'out', 'audio-in']) {
  get(field).oninput = () => { formDirty = true; syncSound(true); };
}
player.addEventListener('timeupdate', () => {
  get('position').value = time(player.currentTime);
  if (playRange && player.currentTime >= playRange.end) {
    player.pause();
    playRange = undefined;
  }
  syncSound();
});
for (const event of ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended']) {
  player.addEventListener(event, () => {
    if (['waiting', 'ended'].includes(event)) audio.pause();
    else syncSound(true);
  });
}
player.addEventListener('error', () => message('Браузер не воспроизвёл этот файл. Для просмотра откройте совместимый исходник.', true));
audio.addEventListener('loadedmetadata', () => syncSound(true));
audio.addEventListener('error', () => message('Браузер не воспроизвёл WAV. Проверьте звук через рендер стыка.', true));
get('result').addEventListener('play', () => player.pause());

action('go', () => seek(seconds(get('seek').value)));
get('seek').addEventListener('keydown', event => { if (event.key === 'Enter') get('go').click(); });
action('mark-in', () => { get('in').value = time(player.currentTime); formDirty = true; syncSound(true); });
action('mark-out', () => { get('out').value = time(player.currentTime); formDirty = true; });
action('play-range', async () => {
  playRange = readClip();
  seek(playRange.start);
  get('result').pause();
  await player.play();
});
action('new', () => { if (discardForm()) fill(-1); });
action('apply', acceptForm);
action('split', () => {
  const clip = readClip();
  const cursor = player.currentTime;
  if (cursor - clip.start < 1 / 30 || clip.end - cursor < 1 / 30) {
    throw new Error('Поставьте курсор внутри клипа, хотя бы в одном кадре от каждого края.');
  }
  const right = { ...clip, start: cursor, audioStart: clip.audioStart + cursor - clip.start };
  clips.splice(selected, 1, { ...clip, end: cursor }, right);
  dirty = true;
  fill(selected + 1);
  message('Клип разделён.');
});
action('save', async () => {
  if (formDirty) throw new Error('Сначала примените изменения клипа или закройте форму.');
  const snapshot = JSON.stringify(clips);
  await api('/api/project', { clips });
  if (snapshot === JSON.stringify(clips)) dirty = false;
  message('Проект сохранён.');
});
action('export', () => startRender());
window.addEventListener('beforeunload', event => {
  if (dirty || formDirty) event.preventDefault();
});

try {
  const project = await api('/api/project');
  get('title').textContent = project.title;
  sound.append(option('', 'Звук камеры'));
  for (const media of project.sources) {
    sources.set(media.name, media);
    const menu = media.kind === 'video' ? source : sound;
    menu.append(option(media.name, media.kind === 'video' ? media.name : `${media.name} · ${time(media.duration)}`));
  }
  clips = project.clips;
  const warnings = [...project.warnings, project.projectError].filter(Boolean);
  if (warnings.length) {
    get('warnings').hidden = false;
    for (const warning of warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      get('warnings').querySelector('ul').append(item);
    }
  }
  fill(clips.length ? 0 : -1);
  await poll();
} catch (error) {
  message(error.message, true);
}
