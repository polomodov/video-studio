import { REGIONS, compositeLayout, validateRegions, defaultComposition } from './composition.mjs';
import { mountCompositionEditor } from './composition-editor.mjs';
let visualEditor, sourcePlayback;
import { mountCanvasPlayer, limitPlayback } from './player.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  jobs: [], job: null, candidateId: null, busy: false, loading: true,
  epoch: 0, drafts: new Map(), jobNodes: new Map(), candidateNodes: new Map(),
  captionNodes: new Map(), inspectorKey: null, sourceId: null, exportUrl: null,
  view: 'source', playbackContext: false, lastJobsRefresh: 0, noticeTimer: null,
  savingIds: new Set(), pollFailures: 0, connectionLost: false,
  templates: [], templatesLoading: false, templateSaving: false, selectedTemplateId: '',
  templateStatus: '', templateError: false,
};
const statusLabels = {
  imported: 'Видео добавлено', transcribing: 'Распознаём речь',
  analyzing: 'Ищем фрагменты', ready: 'Можно выбирать', error: 'Нужно внимание',
};
const renderLabels = {
  queued: 'Ожидает сборки', rendering: 'Собираем ролик…', ready: 'Ролик готов',
  stale: 'Нужно пересобрать', error: 'Не удалось собрать',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timecode(value, decimals = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '—';
  const rounded = Math.round(number * 100) / 100;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = Math.floor(rounded % 60);
  const fraction = decimals && rounded % 1 ? `.${String(Math.round((rounded % 1) * 100)).padStart(2, '0')}` : '';
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${fraction}`;
}

function parseTime(raw) {
  const text = String(raw).trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^\d{1,3}:\d{1,2}(?::\d{1,2})?(?:\.\d+)?$/.test(text)) return NaN;
  const values = text.split(':').map(Number);
  if (values.slice(1).some((part) => part >= 60)) return NaN;
  return values.reduce((total, part) => total * 60 + part, 0);
}

function duration(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds} сек`;
  return `${Math.floor(seconds / 60)} мин${seconds % 60 ? ` ${seconds % 60} сек` : ''}`;
}

function bytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '';
  return Number(value) >= 1024 ** 3 ? `${(Number(value) / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(Number(value) / 1024 ** 2)} МБ`;
}

function errorText(error) {
  if (typeof error === 'string') return error;
  if (error?.message) return String(error.message);
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

function readableContext(value) {
  const segments = new Map((state.job?.segments || []).map((segment) => [segment.id, segment]));
  return String(value || '').replace(/\bs\d+\b/g, (id) => {
    const segment = segments.get(id);
    return segment ? timecode(segment.start) : id;
  });
}

async function api(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(path, {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
    });
  } catch {
    throw new Error('Не удаётся связаться с мастерской. Проверьте, что локальное приложение запущено, и повторите действие.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('Мастерская вернула неожиданный ответ. Попробуйте ещё раз.'); }
  if (!response.ok) throw new Error(errorText(data.error || `Ошибка ${response.status}`));
  return data;
}

function notify(message, isError = false) {
  clearTimeout(state.noticeTimer);
  $('notice-text').textContent = message;
  $('notice').classList.toggle('error', isError);
  $('notice').hidden = false;
  if (!isError) state.noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 7000);
}

function activeCandidate() { return state.job?.candidates?.find((candidate) => candidate.id === state.candidateId) || null; }
function draftKey(candidateId, jobId = state.job?.id) { return `${jobId}:${candidateId}`; }
function effective(candidate) { return { ...candidate, ...(state.drafts.get(draftKey(candidate.id)) || {}) }; }
function ensureDraft(candidate = activeCandidate()) {
  const key = draftKey(candidate.id);
  if (!state.drafts.has(key)) {
    state.drafts.set(key, {
      title: candidate.title || '', start: candidate.start, end: candidate.end,
      layout: candidate.layout || 'fit', cropX: candidate.cropX ?? 0.5,
      ...(candidate.composition ? { composition: structuredClone(candidate.composition) } : {}),
      captions: candidate.captions !== false, captionEdits: { ...(candidate.captionEdits || {}) },
      rawStart: timecode(candidate.start, true), rawEnd: timecode(candidate.end, true), revision: 0,
    });
  }
  const draft = state.drafts.get(key);
  draft.revision += 1;
  return draft;
}

function validComposition(composition, source, layout) {
  try { validateRegions(composition, source, layout); return true; } catch { return false; }
}

function scaleTemplateComposition(template, source) {
  if (template?.version !== 1 || !compositeLayout(template.layout) || !validComposition(template.composition, template.sourceSize, template.layout)) {
    throw new Error('Этот шаблон не поддерживается или повреждён. Сохраните компоновку заново.');
  }
  if (!Number.isInteger(source?.width) || !Number.isInteger(source?.height) || source.width < 2 || source.height < 2) {
    throw new Error('Не удалось определить размер исходника. Повторно откройте выпуск.');
  }
  const sourceRatio = source.width / source.height;
  const templateRatio = template.sourceSize.width / template.sourceSize.height;
  if (Math.abs(sourceRatio / templateRatio - 1) > 0.01) {
    throw new Error('У этого исходника другие пропорции кадра. Выберите шаблон с такими же пропорциями или подготовьте отдельную компоновку.');
  }
  const even = (value) => Math.round(value / 2) * 2;
  const maxWidth = Math.floor(source.width / 2) * 2;
  const maxHeight = Math.floor(source.height / 2) * 2;
  return Object.fromEntries(Object.keys(REGIONS[template.layout]).map((name) => {
    const rect = template.composition[name];
    const x = Math.min(maxWidth - 2, Math.max(0, even(rect.x * source.width / template.sourceSize.width)));
    const y = Math.min(maxHeight - 2, Math.max(0, even(rect.y * source.height / template.sourceSize.height)));
    const width = Math.min(maxWidth - x, Math.max(2, even(rect.width * source.width / template.sourceSize.width)));
    const height = Math.min(maxHeight - y, Math.max(2, even(rect.height * source.height / template.sourceSize.height)));
    return [name, { x, y, width, height }];
  }));
}

function setTemplateStatus(message, isError = false) {
  state.templateStatus = message;
  state.templateError = isError;
  renderTemplates();
}

function renderTemplates() {
  const candidate = activeCandidate();
  const item = candidate ? effective(candidate) : null;
  const locked = state.busy || ['queued', 'rendering'].includes(candidate?.renderStatus);
  const select = $('layout-template');
  const signature = JSON.stringify(state.templates.map(({ id, name }) => [id, name]));
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    const placeholder = element('option', '', 'Выберите шаблон');
    placeholder.value = '';
    select.replaceChildren(placeholder);
    for (const template of state.templates) {
      const option = element('option', '', template.name);
      option.value = template.id;
      select.append(option);
    }
  }
  select.options[0].textContent = state.templatesLoading && !state.templates.length ? 'Загружаем шаблоны…' : state.templates.length ? 'Выберите шаблон' : 'Пока нет шаблонов';
  select.value = state.selectedTemplateId;
  select.disabled = locked || state.templateSaving || !state.templates.length;
  $('refresh-templates').disabled = state.templatesLoading || state.templateSaving;
  $('apply-template').disabled = locked || state.templateSaving || state.templatesLoading || !candidate || !state.templates.some(({ id }) => id === state.selectedTemplateId);
  const canSave = compositeLayout(item?.layout) && validComposition(item.composition, state.job?.source);
  $('template-save-fields').hidden = !canSave;
  $('template-name').disabled = locked || state.templateSaving;
  $('save-template').disabled = locked || state.templateSaving || state.templatesLoading || !canSave || !$('template-name').value.trim();
  $('save-template').textContent = state.templateSaving ? 'Сохраняем шаблон…' : 'Сохранить как шаблон';
  $('template-status').textContent = state.templateStatus;
  $('template-status').hidden = !state.templateStatus;
  $('template-status').classList.toggle('error', state.templateError);
}

async function loadTemplates() {
  if (state.templatesLoading) return;
  state.templatesLoading = true;
  renderTemplates();
  try {
    const data = await api('/api/layout-templates');
    if (!Array.isArray(data.templates)) throw new Error('Не удалось прочитать список шаблонов. Нажмите ↻, чтобы повторить.');
    state.templates = data.templates;
    if (!state.templates.some(({ id }) => id === state.selectedTemplateId)) state.selectedTemplateId = '';
    if (state.templateError) setTemplateStatus('Список шаблонов обновлён.');
  } catch (error) {
    setTemplateStatus(`${errorText(error)} Обновите список кнопкой ↻.`, true);
  } finally {
    state.templatesLoading = false;
    renderTemplates();
  }
}

function applyTemplate() {
  const candidate = activeCandidate();
  if (!candidate || state.busy || state.templateSaving || state.templatesLoading || ['queued', 'rendering'].includes(candidate.renderStatus)) return;
  const template = state.templates.find(({ id }) => id === state.selectedTemplateId);
  if (!template) return;
  try {
    const composition = scaleTemplateComposition(template, state.job.source);
    const draft = ensureDraft(candidate);
    draft.layout = template.layout;
    draft.composition = composition;
    syncInspector(candidate, true);
    renderActive();
    showView('source');
    setTemplateStatus(`«${template.name}» применён. Проверьте рамки, затем сохраните правки.`);
  } catch (error) { setTemplateStatus(errorText(error), true); }
}

async function saveTemplate() {
  const candidate = activeCandidate();
  if (!candidate || state.busy || state.templateSaving || state.templatesLoading || ['queued', 'rendering'].includes(candidate.renderStatus)) return;
  const item = effective(candidate);
  const name = $('template-name').value.trim();
  if (!name || !compositeLayout(item.layout) || !validComposition(item.composition, state.job.source)) return;
  const payload = {
    name, sourceSize: { width: state.job.source.width, height: state.job.source.height },
    layout: item.layout, composition: structuredClone(item.composition),
  };
  state.templateSaving = true;
  setTemplateStatus('');
  try {
    const { template } = await api('/api/layout-templates', 'POST', payload);
    if (!template?.id) throw new Error('Мастерская не подтвердила сохранение. Обновите список шаблонов.');
    state.templates = [template, ...state.templates.filter(({ id }) => id !== template.id)];
    state.selectedTemplateId = template.id;
    setTemplateStatus(`Шаблон «${template.name}» сохранён. Он доступен во всех выпусках.`);
  } catch (error) { setTemplateStatus(errorText(error), true); }
  finally { state.templateSaving = false; renderTemplates(); }
}

function validate(candidate) {
  if (!candidate.title?.trim()) return 'Добавьте название фрагмента.';
  if (!Number.isFinite(candidate.start) || !Number.isFinite(candidate.end)) return 'Введите время как 01:23 или числом секунд.';
  if (candidate.start < 0 || candidate.end <= candidate.start) return 'Конец фрагмента должен быть позже начала.';
  if (candidate.end > Number(state.job?.source?.duration)) return 'Фрагмент не может выходить за конец выпуска.';
  if (candidate.end - candidate.start < 5 || candidate.end - candidate.start > 180) return 'Выберите фрагмент длительностью от 5 до 180 секунд.';
  return '';
}

function setOrderedChild(container, node, index) {
  if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
}

function renderJobs() {
  const container = $('job-list');
  $('job-count').textContent = String(state.jobs.length);
  if (!state.jobs.length) {
    container.replaceChildren(element('p', 'muted small', state.loading ? 'Загружаем выпуски…' : 'Пока нет добавленных видео.'));
    state.jobNodes.clear();
    return;
  }
  if (!state.jobNodes.size) container.replaceChildren();
  const ids = new Set();
  state.jobs.forEach((job, index) => {
    ids.add(job.id);
    let entry = state.jobNodes.get(job.id);
    if (!entry) {
      const button = element('button', 'job-button');
      button.type = 'button';
      const title = element('span', 'job-button-title');
      const meta = element('span', 'job-button-meta');
      button.append(title, meta);
      button.addEventListener('click', () => selectJob(job.id));
      entry = { button, title, meta };
      state.jobNodes.set(job.id, entry);
    }
    entry.title.textContent = job.title || job.source?.name || 'Выпуск';
    const length = job.source?.duration ?? job.duration;
    entry.meta.textContent = [length ? duration(length) : '', statusLabels[job.status] || 'Выпуск'].filter(Boolean).join(' · ');
    entry.button.classList.toggle('active', state.job?.id === job.id);
    entry.button.setAttribute('aria-current', state.job?.id === job.id ? 'true' : 'false');
    entry.button.disabled = state.busy;
    setOrderedChild(container, entry.button, index);
  });
  for (const [id, entry] of state.jobNodes) if (!ids.has(id)) { entry.button.remove(); state.jobNodes.delete(id); }
}

function renderCandidates() {
  const candidates = state.job?.candidates || [];
  const container = $('candidate-list');
  $('candidate-count').textContent = String(candidates.length);
  $('candidate-placeholder').hidden = candidates.length > 0;
  $('candidate-intro').textContent = candidates.length ? 'Откройте, посмотрите, отметьте лучшие.' : state.job && state.job.status !== 'error' ? 'Ищем законченные мысли и хорошие истории.' : 'Здесь появятся идеи для коротких видео.';
  const ids = new Set();
  candidates.forEach((candidate, index) => {
    ids.add(candidate.id);
    const item = effective(candidate);
    let entry = state.candidateNodes.get(candidate.id);
    if (!entry) {
      const wrapper = element('div', 'candidate-item');
      const checkLabel = element('label', 'candidate-check-label');
      const check = element('input');
      check.type = 'checkbox';
      checkLabel.append(check);
      const button = element('button', 'candidate-button');
      button.type = 'button';
      const top = element('span', 'candidate-topline');
      const number = element('span');
      const length = element('span');
      top.append(number, length);
      const title = element('span', 'candidate-card-title');
      const range = element('span', 'candidate-card-time');
      const badge = element('span', 'candidate-render-badge');
      button.append(top, title, range, badge);
      wrapper.append(checkLabel, button);
      button.addEventListener('click', () => selectCandidate(candidate.id));
      check.addEventListener('change', () => setSelected(candidate.id, check.checked));
      entry = { wrapper, check, button, number, length, title, range, badge };
      state.candidateNodes.set(candidate.id, entry);
    }
    entry.wrapper.classList.toggle('active', candidate.id === state.candidateId);
    entry.check.checked = candidate.selected === true;
    entry.check.disabled = state.busy || ['transcribing', 'analyzing'].includes(state.job?.status) || ['queued', 'rendering'].includes(candidate.renderStatus);
    entry.check.setAttribute('aria-label', `Выбрать для сборки: ${item.title}`);
    entry.button.setAttribute('aria-current', candidate.id === state.candidateId ? 'true' : 'false');
    entry.number.textContent = `${String(index + 1).padStart(2, '0')} / ФРАГМЕНТ`;
    entry.length.textContent = duration(item.end - item.start);
    entry.title.textContent = item.title || 'Без названия';
    entry.range.textContent = `${timecode(item.start)} — ${timecode(item.end)}`;
    entry.badge.textContent = renderLabels[candidate.renderStatus] || '';
    entry.badge.hidden = !entry.badge.textContent;
    entry.badge.classList.toggle('error', candidate.renderStatus === 'error');
    setOrderedChild(container, entry.wrapper, index);
  });
  for (const [id, entry] of state.candidateNodes) if (!ids.has(id)) { entry.wrapper.remove(); state.candidateNodes.delete(id); }
}

function renderProgress() {
  const job = state.job;
  const isError = job.status === 'error';
  const active = ['imported', 'transcribing', 'analyzing'].includes(job.status);
  $('progress-panel').hidden = !active && !isError;
  $('progress-panel').classList.toggle('error', isError);
  $('retry-job').hidden = !isError;
  $('retry-job').disabled = state.busy;
  $('progress-title').textContent = isError ? 'Этот шаг не завершился' : job.status === 'transcribing' ? 'Сначала — расшифровка.' : job.status === 'analyzing' ? 'Теперь найдём хорошие фрагменты.' : 'Готовим выпуск к работе.';
  let detail = typeof job.progress === 'string' ? job.progress : job.progress?.message || job.progress?.detail;
  if (isError) detail = errorText(job.error);
  $('progress-text').textContent = detail || (job.status === 'transcribing' ? 'Распознаём речь и сохраняем таймкоды. Длинному выпуску потребуется время.' : job.status === 'analyzing' ? 'Codex читает расшифровку и ищет законченные мысли. Видео остаётся на этом компьютере.' : 'Проверяем видео и готовим его к просмотру.');
  const percent = typeof job.progress === 'number' ? job.progress : job.progress?.percent;
  $('progress-meter').hidden = !Number.isFinite(percent) || isError;
  if (Number.isFinite(percent)) $('progress-meter').value = Math.max(0, Math.min(100, percent));
}

function renderSource() {
  const job = state.job;
  if (state.sourceId === job.id) return;
  state.sourceId = job.id;
  state.playbackContext = false;
  $('source-video').pause();
  $('source-video').src = `/media/${encodeURIComponent(job.id)}/source`;
  $('source-video').poster = `/media/${encodeURIComponent(job.id)}/poster`;
  $('media-error').hidden = true;
  const ratio = Number(job.source?.width) / Number(job.source?.height);
  if (Number.isFinite(ratio) && ratio > 0) $('source-video').parentElement.style.aspectRatio = String(ratio);
  showView('source');
}

function syncInspector(candidate, force = false) {
  const key = draftKey(candidate.id);
  const draft = state.drafts.get(key);
  const item = effective(candidate);
  const locked = ['queued', 'rendering'].includes(candidate.renderStatus);
  const mustSync = force || state.inspectorKey !== key || (!draft && !$('clip-form').contains(document.activeElement));
  if (mustSync) {
    $('edit-title').value = item.title || '';
    $('edit-start').value = draft?.rawStart ?? timecode(item.start, true);
    $('edit-end').value = draft?.rawEnd ?? timecode(item.end, true);
    for (const layout of ['fit', 'crop', 'presentation', 'duo', 'slide-speaker']) $(`layout-${layout}`).checked = item.layout === layout;
    $('edit-crop').value = String(Math.round((item.cropX ?? 0.5) * 100));
    $('edit-captions').checked = item.captions !== false;
    state.inspectorKey = key;
  }
  const problem = validate(item);
  $('range-error').textContent = problem;
  $('range-error').hidden = !problem;
  $('clip-duration').textContent = duration(item.end - item.start);
  $('crop-control').hidden = item.layout !== 'crop';
  $('layout-description').textContent = item.layout === 'duo' ? 'Два участника друг над другом. Выберите их области на исходнике.' : item.layout === 'slide-speaker' ? 'Слайд целиком сверху, спикер снизу. Уточните области на исходнике.' : item.layout === 'presentation'
    ? 'Заголовок и схема сверху, крупный ведущий снизу, субтитры между ними.'
    : item.layout === 'crop' ? 'Вертикальная рамка на видео показывает, что останется в кадре.' : 'Сохраняем спикера, слайды и весь исходный кадр.';
  for (const id of ['edit-title', 'edit-start', 'edit-end', 'layout-fit', 'layout-crop', 'layout-presentation', 'layout-duo', 'layout-slide-speaker', 'edit-crop', 'edit-captions']) $(id).disabled = locked;
  $('layout-presentation').disabled = locked;
  $('layout-presentation-option').hidden = item.layout !== 'presentation';
  $('layout-presentation-option').title = item.composition ? '' : 'Сначала нужно выделить области слайда и ведущего';
  $('layout-presentation-hint').hidden = true;
  $('presentation-preview-hint').hidden = !compositeLayout(item.layout);
  $('save-clip').disabled = !draft || state.busy || locked || Boolean(problem);
  $('save-clip').textContent = state.savingIds.has(candidate.id) ? 'Сохраняем…' : draft ? 'Сохранить правки' : 'Правки сохранены ✓';
  $('save-status').textContent = draft ? 'Есть несохранённые изменения.' : '';
  sourcePlayback?.update();
  renderCrop(item);
  renderTemplates();
}

function renderCrop(candidate) {
  const width = Number(state.job.source?.width) || 1920;
  const height = Number(state.job.source?.height) || 1080;
  const fraction = Math.min(1, (height * 9 / 16) / width);
  $('crop-guide').hidden = candidate.layout !== 'crop';
  $('crop-guide').style.width = `${fraction * 100}%`;
  $('crop-guide').style.left = `${(1 - fraction) * Math.max(0, Math.min(1, candidate.cropX ?? 0.5)) * 100}%`;
  $('composition-guides').hidden = true;
  visualEditor?.update({ source: state.job.source, clip: candidate, segments: state.job.segments, key: draftKey(candidate.id), locked: state.busy || ['queued', 'rendering'].includes(candidate.renderStatus) });
}

function renderCaptions(candidate) {
  const item = effective(candidate);
  const start = Number.isFinite(item.start) ? item.start : candidate.start;
  const end = Number.isFinite(item.end) ? item.end : candidate.end;
  const segments = (state.job.segments || []).filter((segment) => segment.end > start && segment.start < end);
  const container = $('caption-list');
  $('caption-count').textContent = `${segments.length} фраз`;
  const ids = new Set();
  segments.forEach((segment, index) => {
    ids.add(segment.id);
    let entry = state.captionNodes.get(segment.id);
    if (!entry) {
      const row = element('div', 'caption-row');
      const button = element('button', 'caption-time');
      button.type = 'button';
      const input = element('textarea');
      input.rows = 2;
      input.spellcheck = true;
      input.maxLength = 2000;
      button.addEventListener('click', () => {
        state.playbackContext = false;
        showView('source');
        $('source-video').currentTime = Math.max(0, Number(segment.start));
      });
      input.addEventListener('input', () => {
        if (!activeCandidate()) return;
        ensureDraft().captionEdits[segment.id] = input.value;
        renderActionState();
        syncInspector(activeCandidate());
      });
      row.append(button, input);
      entry = { row, button, input };
      state.captionNodes.set(segment.id, entry);
    }
    entry.button.textContent = timecode(segment.start);
    entry.button.setAttribute('aria-label', `Перейти к фразе на ${timecode(segment.start)}`);
    entry.input.setAttribute('aria-label', `Субтитры на ${timecode(segment.start)}`);
    entry.input.disabled = ['queued', 'rendering'].includes(candidate.renderStatus);
    if (document.activeElement !== entry.input) entry.input.value = item.captionEdits?.[segment.id] ?? segment.text ?? '';
    setOrderedChild(container, entry.row, index);
  });
  for (const [id, entry] of state.captionNodes) if (!ids.has(id)) { entry.row.remove(); state.captionNodes.delete(id); }
  if (!segments.length) container.replaceChildren(element('p', 'muted small', 'Для этих границ нет распознанного текста.'));
  else for (const child of [...container.children]) if (!child.classList.contains('caption-row')) child.remove();
}

function safeMediaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/media/') ? url.href : null;
  } catch { return null; }
}

function renderExport(candidate) {
  const exported = candidate?.export;
  const videoUrl = safeMediaUrl(exported?.videoUrl);
  const stale = candidate?.renderStatus === 'stale' || state.drafts.has(draftKey(candidate?.id));
  $('export-tab').disabled = !videoUrl;
  $('export-dot').hidden = !videoUrl || stale;
  $('export-section').hidden = !videoUrl;
  $('export-note').textContent = stale ? 'Это предыдущая версия. Сохраните правки и пересоберите выбранный ролик.' : 'Посмотрите его целиком перед публикацией.';
  if (videoUrl !== state.exportUrl) {
    $('export-video').pause();
    state.exportUrl = videoUrl;
    if (videoUrl) $('export-video').src = videoUrl;
    else { $('export-video').removeAttribute('src'); $('export-video').load(); }
    if (!videoUrl) showView('source');
  }
  const links = $('export-links');
  const signature = JSON.stringify([exported?.videoUrl, exported?.srtUrl, exported?.descriptionUrl]);
  if (links.dataset.signature !== signature) {
    links.dataset.signature = signature;
    links.replaceChildren();
    for (const [label, rawUrl] of [['↓ MP4', exported?.videoUrl], ['Субтитры', exported?.srtUrl], ['Описание', exported?.descriptionUrl]]) {
      const url = safeMediaUrl(rawUrl);
      if (!url) continue;
      const link = element('a', 'button button-small button-light', label);
      link.href = url;
      link.download = '';
      links.append(link);
    }
  }
}

function renderActionState() {
  const candidates = state.job?.candidates || [];
  const selected = candidates.filter((candidate) => candidate.selected);
  const running = candidates.filter((candidate) => ['queued', 'rendering'].includes(candidate.renderStatus));
  const preparing = ['imported', 'transcribing', 'analyzing'].includes(state.job?.status);
  $('selected-count').textContent = String(selected.length);
  $('render-selected').disabled = state.busy || !selected.length || preparing || running.length > 0;
  $('render-selected').textContent = running.length ? 'Собираем ролики…' : 'Собрать выбранные ↗';
  $('render-help').textContent = running.length ? 'Можно продолжать просмотр. Готовые ролики появятся в своих карточках.' : selected.length ? 'Перед сборкой сохраним правки выбранных фрагментов.' : 'Отметьте фрагменты слева. Сборка начнётся по вашей команде.';
  $('play-clip').disabled = !activeCandidate();
  $('play-context').disabled = !activeCandidate();
  const candidate = activeCandidate();
  const renderStatus = candidate?.renderStatus;
  $('render-status').hidden = !renderStatus || renderStatus === 'idle';
  $('render-status').classList.toggle('error', renderStatus === 'error');
  $('render-status').textContent = renderStatus === 'error' ? `Не удалось собрать: ${errorText(candidate.renderError)}` : renderLabels[renderStatus] || '';
  $('open-import').disabled = state.busy || state.loading;
  $('empty-import').disabled = state.busy || state.loading;
}

function renderActive() {
  const candidate = activeCandidate();
  $('inspector-empty').hidden = Boolean(candidate);
  $('clip-form').hidden = !candidate;
  $('clip-story').hidden = !candidate;
  $('caption-section').hidden = !candidate;
  if (!candidate) {
    $('crop-guide').hidden = true;
    $('composition-guides').hidden = true;
    $('presentation-preview-hint').hidden = true;
    visualEditor?.update({});
    renderTemplates();
    renderExport(null);
    renderActionState();
    return;
  }
  const item = effective(candidate);
  $('clip-number').textContent = `${String(state.job.candidates.indexOf(candidate) + 1).padStart(2, '0')} / ${String(state.job.candidates.length).padStart(2, '0')}`;
  $('clip-title').textContent = item.title;
  $('clip-reason').textContent = readableContext(candidate.reason) || 'Посмотрите фрагмент и проверьте, понятна ли мысль без полного выпуска.';
  $('clip-hook').textContent = candidate.hook || '';
  $('clip-hook').hidden = !candidate.hook;
  const caution = candidate.caution || candidate.contextRisk;
  $('clip-caution').textContent = caution ? `Контекст: ${readableContext(caution)}` : '';
  $('clip-caution').hidden = !caution;
  syncInspector(candidate);
  renderCaptions(candidate);
  renderExport(candidate);
  renderActionState();
}

function renderAll() {
  renderJobs();
  renderCandidates();
  $('empty-state').hidden = Boolean(state.job);
  $('job-workspace').hidden = !state.job;
  if (!state.job) { renderActionState(); return; }
  const job = state.job;
  $('job-title').textContent = job.title || job.source?.name || 'Выпуск';
  $('job-meta').textContent = [job.source?.duration ? duration(job.source.duration) : '', bytes(job.source?.bytes), 'Исходник на этом компьютере'].filter(Boolean).join('  ·  ');
  updateResolutionLabel();
  $('job-status').textContent = statusLabels[job.status] || 'В работе';
  $('job-status').classList.toggle('working', ['imported', 'transcribing', 'analyzing'].includes(job.status));
  $('job-status').classList.toggle('error', job.status === 'error');
  renderSource();
  renderProgress();
  renderActive();
}

function applyJob(job) {
  if (!job || !job.id) throw new Error('Ответ не содержит выпуск. Повторите действие.');
  const changedJob = state.job?.id !== job.id;
  job.candidates ||= [];
  job.segments ||= [];
  state.job = job;
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) state.jobs[index] = { ...state.jobs[index], ...job };
  else state.jobs.unshift(job);
  if (changedJob) {
    state.playbackContext = false;
    if (!state.templateError) state.templateStatus = '';
    state.candidateId = job.candidates[0]?.id || null;
    state.inspectorKey = null;
    state.candidateNodes.clear();
    $('candidate-list').replaceChildren();
    state.captionNodes.clear();
    $('caption-list').replaceChildren();
    try { localStorage.setItem('shorts-current-job', job.id); } catch { /* Storage may be disabled. */ }
  } else if (!job.candidates.some((candidate) => candidate.id === state.candidateId)) {
    state.candidateId = job.candidates[0]?.id || null;
  }
  renderAll();
}

async function withAction(action) {
  if (state.busy) return;
  state.busy = true;
  state.epoch += 1;
  renderAll();
  try { await action(); } catch (error) { notify(errorText(error), true); }
  finally { state.busy = false; renderAll(); }
}

async function selectJob(id) {
  if (state.busy || state.job?.id === id) return;
  await withAction(async () => {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    applyJob(job);
  });
}

function selectCandidate(id) {
  if (state.candidateId === id) return;
  state.candidateId = id;
  if (!state.templateError) state.templateStatus = '';
  state.playbackContext = false;
  $('source-video').pause();
  $('export-video').pause();
  state.inspectorKey = null;
  renderCandidates();
  renderActive();
  showView('source');
  const item = activeCandidate();
  if (item && $('source-video').readyState >= 1) $('source-video').currentTime = effective(item).start;
}

async function setSelected(id, selected) {
  await withAction(async () => {
    applyJob(await api(`/api/jobs/${encodeURIComponent(state.job.id)}/candidates/${encodeURIComponent(id)}`, 'PATCH', { selected }));
  });
}

function editField(field, value) {
  if (!activeCandidate()) return;
  const draft = ensureDraft();
  if (field === 'start' || field === 'end') {
    draft[field === 'start' ? 'rawStart' : 'rawEnd'] = value;
    draft[field] = parseTime(value);
  } else draft[field] = value;
  syncInspector(activeCandidate());
  renderCandidates();
  renderActionState();
  renderExport(activeCandidate());
}

async function saveCandidate(candidateId) {
  const key = draftKey(candidateId);
  const draft = state.drafts.get(key);
  if (!draft) return;
  const candidate = state.job.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error('Этот фрагмент больше недоступен. Выберите другой.');
  const problem = validate(draft);
  if (problem) throw new Error(`${draft.title || 'Фрагмент'}: ${problem}`);
  const revision = draft.revision;
  const payload = {
    title: draft.title.trim(), start: draft.start, end: draft.end,
    layout: draft.layout, cropX: draft.cropX, captions: draft.captions,
    captionEdits: { ...draft.captionEdits },
    ...((draft.composition || candidate.composition) ? { composition: structuredClone(draft.composition || candidate.composition) } : {}),
  };
  state.savingIds.add(candidateId);
  if (activeCandidate()) syncInspector(activeCandidate());
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.job.id)}/candidates/${encodeURIComponent(candidateId)}`, 'PATCH', payload);
    if (state.drafts.get(key)?.revision === revision) state.drafts.delete(key);
    applyJob(job);
  } finally {
    state.savingIds.delete(candidateId);
  }
}

function updateResolutionLabel() {
  const source = state.job?.source;
  $('source-resolution').textContent = state.view === 'export' ? '1080 × 1920' : source?.width && source?.height ? `${source.width} × ${source.height}` : '';
}

function showView(view) {
  if (view === 'export' && !state.exportUrl) return;
  state.view = view;
  updateResolutionLabel();
  $('source-view').hidden = view !== 'source';
  $('export-view').hidden = view !== 'export';
  $('source-tab').classList.toggle('active', view === 'source');
  $('export-tab').classList.toggle('active', view === 'export');
  $('source-tab').setAttribute('aria-selected', String(view === 'source'));
  $('export-tab').setAttribute('aria-selected', String(view === 'export'));
  if (view === 'source') $('export-video').pause();
  else $('source-video').pause();
  $('player-time').textContent = timecode((view === 'source' ? $('source-video') : $('export-video')).currentTime);
}

async function playCandidate(context = false) {
  const candidate = activeCandidate();
  if (!candidate) return;
  const item = effective(candidate);
  const problem = validate(item);
  if (problem) { notify(problem, true); return; }
  showView('source');
  const video = $('source-video');
  state.playbackContext = context;
  video.currentTime = Math.max(0, item.start - (context ? 10 : 0));
  try { await video.play(); } catch { notify('Не удалось запустить видео. Попробуйте кнопку воспроизведения в самом плеере.', true); }
}

async function refreshJobs() {
  const data = await api('/api/jobs');
  state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  state.lastJobsRefresh = Date.now();
  renderJobs();
}

async function loadInitial() {
  state.loading = true;
  $('retry-load').hidden = true;
  renderActionState();
  try {
    await Promise.all([refreshJobs(), loadTemplates()]);
    let remembered;
    try { remembered = localStorage.getItem('shorts-current-job'); } catch { /* Storage may be disabled. */ }
    const id = state.jobs.find((job) => job.id === remembered)?.id || state.jobs[0]?.id;
    if (id) applyJob(await api(`/api/jobs/${encodeURIComponent(id)}`));
    $('notice').hidden = true;
  } catch (error) {
    notify(errorText(error), true);
    $('retry-load').hidden = false;
  } finally {
    state.loading = false;
    renderAll();
  }
}

async function poll() {
  try {
    if (!state.busy && !state.loading) {
      const epoch = state.epoch;
      const id = state.job?.id;
      if (id) {
        const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
        if (state.epoch === epoch && state.job?.id === id && !state.busy) applyJob(job);
      }
      if (!state.busy && Date.now() - state.lastJobsRefresh > 10000) await refreshJobs();
      state.pollFailures = 0;
      if (state.connectionLost) {
        state.connectionLost = false;
        notify('Соединение с мастерской восстановлено.');
      }
    }
  } catch {
    // Keep unsaved edits and the playing video intact during temporary disconnections.
    state.pollFailures += 1;
    if (state.pollFailures >= 3 && !state.connectionLost) {
      state.connectionLost = true;
      notify('Связь с мастерской прервалась. Проверьте, что локальное приложение запущено. Несохранённые правки остаются в этой вкладке.', true);
    }
  } finally { setTimeout(poll, document.hidden ? 6000 : 2000); }
}

function openImport() {
  $('import-error').hidden = true;
  $('import-dialog').showModal();
  $('source-path').focus();
}

$('open-import').addEventListener('click', openImport);
$('empty-import').addEventListener('click', openImport);
$('close-import').addEventListener('click', () => $('import-dialog').close());
$('import-dialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('retry-load').addEventListener('click', loadInitial);
$('source-tab').addEventListener('click', () => showView('source'));
$('export-tab').addEventListener('click', () => showView('export'));
for (const tab of [$('source-tab'), $('export-tab')]) tab.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const available = [$('source-tab'), $('export-tab')].filter((button) => !button.disabled);
  const current = available.indexOf(event.currentTarget);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
  event.preventDefault();
  available[index].focus();
  showView(available[index].id === 'source-tab' ? 'source' : 'export');
});
$('play-clip').addEventListener('click', () => playCandidate(false));
$('play-context').addEventListener('click', () => playCandidate(true));
$('edit-title').addEventListener('input', (event) => editField('title', event.target.value));
$('edit-start').addEventListener('input', (event) => editField('start', event.target.value));
$('edit-end').addEventListener('input', (event) => editField('end', event.target.value));
for (const id of ['edit-start', 'edit-end']) $(id).addEventListener('change', () => {
  if (activeCandidate()) renderCaptions(activeCandidate());
});
$('layout-fit').addEventListener('change', () => editField('layout', 'fit'));
$('layout-crop').addEventListener('change', () => editField('layout', 'crop'));
for (const layout of ['presentation', 'duo', 'slide-speaker']) $(`layout-${layout}`).addEventListener('change', () => {
  const draft = ensureDraft();
  if (['Слайд + ведущий', 'Два участника', 'Слайд + спикер'].includes($('template-name').value)) $('template-name').value = layout === 'duo' ? 'Два участника' : 'Слайд + спикер';
  if (!validComposition(draft.composition, state.job.source, layout)) draft.composition = defaultComposition(layout, state.job.source);
  editField('layout', layout);
});
$('layout-template').addEventListener('change', (event) => {
  state.selectedTemplateId = event.target.value;
  setTemplateStatus('');
});
$('refresh-templates').addEventListener('click', loadTemplates);
$('apply-template').addEventListener('click', applyTemplate);
$('save-template').addEventListener('click', saveTemplate);
$('template-name').addEventListener('input', renderTemplates);
$('template-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); saveTemplate(); }
});
$('edit-crop').addEventListener('input', (event) => editField('cropX', Number(event.target.value) / 100));
$('edit-captions').addEventListener('change', (event) => editField('captions', event.target.checked));
$('clip-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!activeCandidate()) return;
  const id = state.candidateId;
  withAction(async () => { await saveCandidate(id); notify('Правки фрагмента сохранены.'); });
});
$('retry-job').addEventListener('click', () => withAction(async () => {
  applyJob(await api(`/api/jobs/${encodeURIComponent(state.job.id)}/prepare`, 'POST', {}));
}));
$('render-selected').addEventListener('click', () => withAction(async () => {
  const ids = state.job.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.id);
  if (!ids.length) return;
  for (const id of ids) await saveCandidate(id);
  applyJob(await api(`/api/jobs/${encodeURIComponent(state.job.id)}/render`, 'POST', { candidateIds: ids }));
  notify('Выбранные фрагменты отправлены на сборку.');
}));
$('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const raw = $('source-path').value.trim();
  const sourcePath = /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
  if (!sourcePath.startsWith('/') && !/^[a-z]:[\\/]/i.test(sourcePath)) {
    $('import-error').textContent = 'Нужен полный путь к файлу, например /Users/имя/Downloads/выпуск.mp4.';
    $('import-error').hidden = false;
    return;
  }
  state.busy = true;
  state.epoch += 1;
  $('submit-import').disabled = true;
  $('close-import').disabled = true;
  $('submit-import').textContent = 'Добавляем видео…';
  $('import-error').hidden = true;
  try {
    const job = await api('/api/jobs', 'POST', { sourcePath });
    applyJob(job);
    $('import-dialog').close();
    $('source-path').value = '';
    notify('Видео добавлено. Начинаем подготовку фрагментов.');
  } catch (error) {
    $('import-error').textContent = errorText(error);
    $('import-error').hidden = false;
  } finally {
    state.busy = false;
    $('submit-import').disabled = false;
    $('close-import').disabled = false;
    $('submit-import').textContent = 'Найти фрагменты →';
    renderAll();
  }
});
$('source-video').addEventListener('timeupdate', () => {
  const video = $('source-video');
  if (state.view === 'source') $('player-time').textContent = timecode(video.currentTime);

});
$('export-video').addEventListener('timeupdate', () => {
  if (state.view === 'export') $('player-time').textContent = timecode($('export-video').currentTime);
});
$('source-video').addEventListener('error', () => {
  if (!$('source-video').getAttribute('src')) return;
  $('media-error').textContent = 'Не удалось открыть исходное видео. Проверьте, что файл доступен и поддерживается браузером.';
  $('media-error').hidden = false;
});
$('source-video').addEventListener('loadedmetadata', () => {
  $('media-error').hidden = true;
  const candidate = activeCandidate();
  if (candidate && Number.isFinite(effective(candidate).start)) $('source-video').currentTime = effective(candidate).start;
});
window.addEventListener('beforeunload', (event) => {
  if (state.drafts.size) { event.preventDefault(); event.returnValue = ''; }
});

sourcePlayback = limitPlayback($('source-video'), () => {
  const candidate = activeCandidate();
  if (!candidate) return null;
  const item = effective(candidate), padding = state.playbackContext ? 10 : 0;
  return { start: Math.max(0, item.start - padding), end: Math.min(Number(state.job.source.duration), item.end + padding) };
});
visualEditor = mountCompositionEditor({ video: $('source-video'), onChange: (composition) => {
  const candidate = activeCandidate();
  if (!candidate || state.busy || ['queued', 'rendering'].includes(candidate.renderStatus)) return;
  ensureDraft(candidate).composition = structuredClone(composition);
  syncInspector(candidate);
  renderActionState();
  renderExport(candidate);
} });
mountCanvasPlayer($('source-video'), { label: 'Исходник', onError: notify });
mountCanvasPlayer($('export-video'), { label: 'Готовый ролик', onError: notify });
await loadInitial();
setTimeout(poll, 2000);
