import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultComposition, validateRegions, renderPlan, clampRect, sourcePoint } from './ui/composition.mjs';
import { editCandidate } from './core.mjs';
import { validateLayoutTemplate } from './layout-templates.mjs';
import { videoFilterArgs, renderRevision, subtitlesAss } from './media.mjs';
const source = { width: 1920, height: 1080, duration: 30, sha256: 'example' };
for (const layout of ['duo', 'slide-speaker', 'presentation']) {
  test(`${layout}: valid bounds, shared output plan, template and PATCH revision`, () => {
    const composition = defaultComposition(layout, source);
    assert.deepEqual(validateRegions(composition, source, layout), composition);
    const plan = renderPlan(source, { layout, composition });
    assert.equal(plan.blocks.reduce((sum, block) => sum + block.height, 0), 1920);
    for (const block of plan.blocks) {
      assert.ok(block.source.x >= 0 && block.source.y >= 0);
      assert.ok(block.source.x + block.source.width <= source.width);
      assert.ok(block.source.y + block.source.height <= source.height);
      assert.ok(block.target.width <= 1080 && block.target.height <= block.height);
    }
    const clip = { id: 'test', start: 0, end: 10, title: 'Test', layout: 'fit', cropX: .5, selected: true, captions: true, captionEdits: {}, renderStatus: 'ready', export: { revision: 'old' } };
    const updated = editCandidate(clip, { layout, composition }, { source, segments: [] });
    assert.equal(updated.export, null);
    assert.equal(updated.renderStatus, 'stale');
    assert.notEqual(renderRevision(source, clip, []), renderRevision(source, updated, []));
    assert.equal(validateLayoutTemplate({ name: 'Example', sourceSize: { width: 1920, height: 1080 }, layout, composition }).layout, layout);
    assert.equal(videoFilterArgs(source, updated, true)[0], '-filter_complex');
    assert.match(subtitlesAss([{ start: 0, end: 1, lines: ['Тест'] }], updated), new RegExp(`\\\\pos\\(540,${plan.captionY}\\)`));
  });
}
test('strict region shape, even pixel clamp on odd source, source coordinate conversion', () => {
  const composition = defaultComposition('duo', source);
  assert.throws(() => validateRegions({ ...composition, extra: composition.first }, source, 'duo'));
  assert.throws(() => validateRegions(composition, source, 'slide-speaker'));
  assert.throws(() => validateRegions({ ...composition, first: { ...composition.first, x: 1 } }, source, 'duo'));
  assert.deepEqual(clampRect({ x: 900, y: -20, width: 900, height: 900 }, { width: 961, height: 541 }), { x: 900, y: 0, width: 60, height: 540 });
  assert.deepEqual(sourcePoint(250, 150, { left: 10, top: 15, width: 480, height: 270 }, source), { x: 960, y: 540 });
});

test('a tiny square region is cropped after scaling, without stretching it to a wide tile', () => {
  const composition = defaultComposition('duo', source);
  composition.first = { x: 0, y: 0, width: 2, height: 2 };
  const block = renderPlan(source, { layout: 'duo', composition }).blocks[0];
  assert.deepEqual(block.encode.scaled, { width: 1080, height: 1080 });
  assert.equal(block.source.width, 2);
  assert.ok(block.source.height < 2);
  assert.match(videoFilterArgs(source, { layout: 'duo', composition }, false)[1], /scale=1080:1080,crop=1080:840/);
});

test('extremely narrow selection keeps intermediate frames bounded', () => {
  const composition = defaultComposition('duo', source);
  composition.first = { x: 0, y: 0, width: 2, height: 1080 };
  const block = renderPlan(source, { layout: 'duo', composition }).blocks[0];
  assert.ok(block.encode.scaled.width <= 1082 && block.encode.scaled.height <= 1080);
});
