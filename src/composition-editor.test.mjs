import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCompositionEditor } from './ui/composition-editor.mjs';
import { defaultComposition } from './ui/composition.mjs';

// A small DOM surface exercises actual event handlers without a browser dependency.
class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map();
    this.classes = new Set(); this.classList = { toggle: (key, yes) => yes ? this.classes.add(key) : this.classes.delete(key) };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  before(node) { this.parentElement.append(node); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { const list = this.listeners.get(key) || []; list.push(fn); this.listeners.set(key, list); }
  fire(key, event = {}) { for (const fn of this.listeners.get(key) || []) fn({ button: 0, pointerId: 1, target: this, preventDefault() {}, ...event }); }
  replaceChildren() { this.children = []; }
  getContext() { return { fillRect() {}, save() {}, scale() {}, drawImage() {}, restore() {}, strokeText() {}, fillText() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; }
  closest(selector) { return selector === '.region-box' && this.className?.includes('region-box') ? this : null; }
  focus() { globalThis.document.activeElement = this; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
}
test('mouse drawing, Escape/cancel, keyboard moves, numeric clamp, paused repaint and locked controls', () => {
  const original = globalThis.document;
  const doc = new Node(); doc.createElement = tag => new Node(tag); globalThis.document = doc;
  try {
    const view = new Node(), frame = new Node(), video = new Node('video');
    view.append(frame); frame.append(video); video.readyState = 4; video.videoWidth = 1920; video.currentTime = 1;
    const source = { width: 1920, height: 1080 };
    const initial = defaultComposition('duo', source);
    let changed, count = 0;
    const editor = mountCompositionEditor({ video, onChange: geometry => { changed = structuredClone(geometry); count++; } });
    const clip = { layout: 'duo', composition: initial, start: 0, end: 6 };
    editor.update({ source, clip, key: 'test' });
    const overlay = frame.children.find(n => n.className === 'region-overlay');
    const tools = frame.parentElement.children.find(n => n.className === 'region-tools');
    const [choices, redraw, , fields] = tools.children;
    redraw.fire('click');
    overlay.fire('pointerdown', { clientX: 50, clientY: 50 });
    overlay.fire('pointermove', { clientX: 300, clientY: 300 });
    assert.deepEqual(changed.first, { x: 100, y: 100, width: 500, height: 500 });
    doc.fire('keydown', { key: 'Escape' });
    assert.deepEqual(changed, initial);
    redraw.fire('click'); overlay.fire('pointerdown', { clientX: 50, clientY: 50 });
    overlay.fire('pointermove', { clientX: 300, clientY: 300 }); overlay.fire('pointercancel');
    assert.deepEqual(changed, initial);
    overlay.children[0].fire('keydown', { key: 'ArrowRight' });
    assert.equal(changed.first.x, 2);
    const x = fields.children[0].children[0]; x.valueAsNumber = 99999; x.fire('change');
    assert.equal(changed.first.x, 960); assert.equal(changed.first.width, 960); assert.equal(x.value, '960');
    const before = count;
    video.fire('seeked'); assert.equal(count, before, 'preview does not write a draft');
    editor.update({ source, clip: { ...clip, composition: changed }, locked: true, key: 'test' });
    overlay.children[0].fire('keydown', { key: 'ArrowLeft' }); assert.equal(count, before);
    editor.update({ source, clip: { layout: 'slide-speaker', composition: defaultComposition('slide-speaker', source), start: 0, end: 6 }, key: 'other' });
    assert.equal(choices.children[0].textContent, 'Слайд');
    editor.update({}); assert.equal(overlay.hidden, true);
  } finally { globalThis.document = original; }
});
