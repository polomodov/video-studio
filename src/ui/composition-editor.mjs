import { REGIONS, compositeLayout, validateRegions, clampRect, sourcePoint, renderPlan } from './composition.mjs';
import { subtitleCues } from './captions.mjs';

export function mountCompositionEditor({ video, onChange }) {
  const frame = video.parentElement, view = frame.parentElement;
  const pair = document.createElement('div'); pair.className = 'composition-workbench';
  frame.before(pair);
  const sourceColumn = document.createElement('div'); sourceColumn.className = 'composition-source';
  sourceColumn.append(frame); pair.append(sourceColumn);
  const preview = document.createElement('aside'); preview.className = 'vertical-preview';
  const heading = document.createElement('div'); heading.className = 'preview-heading'; heading.textContent = 'Вертикальное превью · 9:16';
  const canvas = document.createElement('canvas'); canvas.width = 540; canvas.height = 960;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Живое превью вертикальной компоновки');
  const hint = document.createElement('p'); hint.className = 'input-hint'; hint.textContent = 'Превью учитывает несохранённые правки.';
  preview.append(heading, canvas, hint); pair.append(preview);
  const context = canvas.getContext('2d', { alpha: false });
  const overlay = document.createElement('div'); overlay.className = 'region-overlay'; frame.append(overlay);
  const tools = document.createElement('section'); tools.className = 'region-tools'; tools.setAttribute('aria-label', 'Области исходника'); sourceColumn.append(tools);
  const choices = document.createElement('div'); choices.className = 'region-choices'; tools.append(choices);
  const redraw = document.createElement('button'); redraw.type = 'button'; redraw.className = 'button button-small button-light'; redraw.textContent = 'Выделить заново'; tools.append(redraw);
  const instructions = document.createElement('p'); instructions.className = 'input-hint'; instructions.textContent = 'Выберите область. Перетаскивайте рамку и её углы. Стрелки — сдвиг, Shift — крупный шаг, Esc — отмена жеста.'; tools.append(instructions);
  const fields = document.createElement('div'); fields.className = 'region-fields'; tools.append(fields);
  let current = null, selected = null, signature = '', drawing = false, gesture = null, cues = [];
  const inputs = new Map(), boxes = new Map();
  const labels = { x: 'X', y: 'Y', width: 'Ширина', height: 'Высота' };
  for (const key of Object.keys(labels)) {
    const label = document.createElement('label'); label.textContent = labels[key];
    const input = document.createElement('input'); input.type = 'number'; input.step = '2'; input.min = key === 'x' || key === 'y' ? '0' : '2';
    input.setAttribute('aria-label', `Область: ${labels[key]}`);
    input.addEventListener('change', () => {
      if (!current || current.locked || !selected) return;
      if (Number.isFinite(input.valueAsNumber)) {
        const rect = current.clip.composition[selected];
        let value = input.valueAsNumber;
        if (key === 'x') value = Math.max(0, Math.min(Math.floor(current.source.width / 2) * 2 - rect.width, value));
        if (key === 'y') value = Math.max(0, Math.min(Math.floor(current.source.height / 2) * 2 - rect.height, value));
        change(clampRect({ ...rect, [key]: value }, current.source));
      }
      input.value = String(current.clip.composition[selected][key]);
      sync();
    });
    inputs.set(key, input); label.append(input); fields.append(label);
  }
  function change(rect) {
    if (!current || current.locked || !selected) return;
    const composition = { ...current.clip.composition, [selected]: rect };
    current.clip = { ...current.clip, composition };
    onChange(composition); sync(); paint();
  }
  function setDrawing(value) {
    drawing = value;
    overlay.classList.toggle('drawing', value);
    redraw.setAttribute('aria-pressed', String(value));
    redraw.textContent = value ? 'Нарисуйте область на исходнике…' : 'Выделить заново';
  }
  redraw.addEventListener('click', () => setDrawing(!drawing));
  function cancelGesture() {
    if (!gesture) { setDrawing(false); return; }
    const previous = gesture.before; gesture = null; setDrawing(false); change(previous);
  }
  function point(event) { return sourcePoint(event.clientX, event.clientY, overlay.getBoundingClientRect(), current.source); }
  overlay.addEventListener('pointerdown', (event) => {
    if (!current || current.locked || !selected || event.button !== 0) return;
    const box = event.target.closest('.region-box');
    if (!drawing && box?.dataset.region !== selected) return;
    const p = point(event), before = { ...current.clip.composition[selected] };
    gesture = { pointerId: event.pointerId, start: p, before, mode: drawing ? 'draw' : event.target.dataset.corner || 'move' };
    overlay.setPointerCapture(event.pointerId); event.preventDefault(); boxes.get(selected)?.focus({ preventScroll: true });
  });
  overlay.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const p = point(event), { start, before: r, mode } = gesture;
    let rect;
    if (mode === 'move') {
      rect = { ...r, x: Math.max(0, Math.min(Math.floor(current.source.width / 2) * 2 - r.width, r.x + p.x - start.x)), y: Math.max(0, Math.min(Math.floor(current.source.height / 2) * 2 - r.height, r.y + p.y - start.y)) };
    } else {
      const anchor = mode === 'draw' ? start : { x: mode.includes('w') ? r.x + r.width : r.x, y: mode.includes('n') ? r.y + r.height : r.y };
      rect = { x: Math.min(anchor.x, p.x), y: Math.min(anchor.y, p.y), width: Math.abs(p.x - anchor.x), height: Math.abs(p.y - anchor.y) };
    }
    change(clampRect(rect, current.source));
  });
  overlay.addEventListener('pointerup', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture = null; setDrawing(false);
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
  });
  overlay.addEventListener('pointercancel', cancelGesture);
  overlay.addEventListener('lostpointercapture', () => { if (gesture) cancelGesture(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (gesture || drawing)) { event.preventDefault(); cancelGesture(); }
  });
  function build() {
    choices.replaceChildren(); overlay.replaceChildren(); boxes.clear();
    for (const [name, label] of Object.entries(REGIONS[current.clip.layout] || {})) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.className = 'region-choice'; button.dataset.region = name;
      button.addEventListener('click', () => { cancelGesture(); selected = name; setDrawing(false); sync(); }); choices.append(button);
      const box = document.createElement('div'); box.className = `region-box region-${name}`; box.dataset.region = name;
      box.tabIndex = -1; box.setAttribute('role', 'group'); box.setAttribute('aria-label', `${label}: рамка, стрелки для перемещения`);
      const title = document.createElement('span'); title.className = 'region-label'; title.textContent = label; box.append(title);
      for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const handle = document.createElement('span'); handle.className = `region-handle handle-${corner}`; handle.dataset.corner = corner; box.append(handle);
      }
      box.addEventListener('keydown', (event) => {
        if (current.locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const r = current.clip.composition[name], delta = event.shiftKey ? 20 : 2;
        change(clampRect({ ...r, x: Math.max(0, Math.min(Math.floor(current.source.width / 2) * 2 - r.width, r.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0))), y: Math.max(0, Math.min(Math.floor(current.source.height / 2) * 2 - r.height, r.y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0))) }, current.source));
      });
      boxes.set(name, box); overlay.append(box);
    }
  }
  function sync() {
    if (!current || !compositeLayout(current.clip.layout)) return;
    for (const button of choices.children) {
      button.setAttribute('aria-pressed', String(button.dataset.region === selected)); button.disabled = current.locked;
    }
    redraw.disabled = current.locked;
    for (const [name, box] of boxes) {
      const rect = current.clip.composition[name];
      box.classList.toggle('active', name === selected); box.tabIndex = name === selected && !current.locked ? 0 : -1;
      box.style.left = `${rect.x / current.source.width * 100}%`; box.style.top = `${rect.y / current.source.height * 100}%`;
      box.style.width = `${rect.width / current.source.width * 100}%`; box.style.height = `${rect.height / current.source.height * 100}%`;
    }
    overlay.classList.toggle('locked', current.locked);
    for (const [key, input] of inputs) {
      if (document.activeElement !== input) input.value = String(current.clip.composition[selected][key]);
      input.disabled = current.locked;
    }
  }
  function paint() {
    if (!current || !context) return;
    context.fillStyle = '#101820'; context.fillRect(0, 0, canvas.width, canvas.height);
    let plan;
    try { plan = renderPlan(current.source, current.clip); } catch { return; }
    context.save(); context.scale(canvas.width / 1080, canvas.height / 1920);
    for (const block of plan.blocks) {
      context.fillStyle = block.background; context.fillRect(0, block.y, 1080, block.height);
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const s = block.source, t = block.target;
        context.drawImage(video, s.x, s.y, s.width, s.height, t.x, block.y + t.y, t.width, t.height);
      }
    }
    if (current.clip.captions !== false) {
      const time = video.currentTime - current.clip.start;
      const cue = cues.find((item) => item.start <= time && time < item.end);
      if (cue) {
        context.font = 'bold 54px Arial'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.lineJoin = 'round'; context.lineWidth = 6; context.strokeStyle = '#101010'; context.fillStyle = 'white';
        const midY = plan.captionY ?? 1920 - 240 - cue.lines.length * 62 / 2;
        cue.lines.forEach((line, i) => {
          const y = midY + (i - (cue.lines.length - 1) / 2) * 62;
          const text = line.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')');
          context.strokeText(text, 540, y); context.fillText(text, 540, y);
        });
      }
    }
    context.restore();
  }
  function update({ source, clip, segments = [], locked = false, key = '' }) {
    if (!source || !clip) { current = null; tools.hidden = true; overlay.hidden = true; preview.hidden = true; return; }
    const nextSignature = `${key}:${clip.layout}`;
    if (gesture && signature !== nextSignature) { gesture = null; setDrawing(false); }
    current = { source, clip, locked };
    cues = subtitleCues(segments, clip);
    const valid = compositeLayout(clip.layout) && (() => { try { validateRegions(clip.composition, source, clip.layout); return true; } catch { return false; } })();
    tools.hidden = !valid; overlay.hidden = !valid; preview.hidden = false;
    if (valid) {
      if (signature !== nextSignature) { selected = Object.keys(REGIONS[clip.layout])[0]; setDrawing(false); build(); }
      sync();
    }
    signature = nextSignature; paint();
  }
  // Reuse the player's decoded-frame notifications, plus paused seek events.
  for (const event of ['studioframe', 'seeked', 'loadeddata', 'pause', 'emptied']) video.addEventListener(event, paint);
  tools.hidden = true; overlay.hidden = true; preview.hidden = true;
  return { update, paint };
}
