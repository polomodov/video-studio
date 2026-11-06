// Source pixels are the persisted geometry. Both preview and encoder consume this plan.
export const REGIONS = {
  presentation: { heading: 'Заголовок', slide: 'Слайд', speaker: 'Спикер' },
  duo: { first: 'Участник 1', second: 'Участник 2' },
  'slide-speaker': { slide: 'Слайд', speaker: 'Спикер' },
};
export const compositeLayout = (layout) => Object.hasOwn(REGIONS, layout);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export function inferLayout(composition) {
  return Object.keys(REGIONS).find((layout) => object(composition) &&
    Object.keys(composition).length === Object.keys(REGIONS[layout]).length &&
    Object.keys(composition).every((key) => Object.hasOwn(REGIONS[layout], key)));
}
export function validateRegions(composition, source, layout = inferLayout(composition)) {
  const regions = REGIONS[layout], coordinates = ['x', 'y', 'width', 'height'];
  if (!regions || !object(composition) || Object.keys(composition).length !== Object.keys(regions).length ||
    !Object.keys(composition).every((key) => Object.hasOwn(regions, key))) throw new Error('Нужны все области выбранной компоновки без лишних полей.');
  if (!Number.isInteger(source?.width) || !Number.isInteger(source?.height) || source.width < 2 || source.height < 2) throw new Error('Неизвестен размер исходного видео.');
  return Object.fromEntries(Object.keys(regions).map((name) => {
    const rect = composition[name];
    if (!object(rect) || Object.keys(rect).length !== 4 || !Object.keys(rect).every((key) => coordinates.includes(key)) ||
      !coordinates.every((key) => Number.isInteger(rect[key]) && rect[key] % 2 === 0) ||
      rect.x < 0 || rect.y < 0 || rect.width < 2 || rect.height < 2 ||
      rect.x + rect.width > source.width || rect.y + rect.height > source.height) {
      throw new Error(`Область «${regions[name]}» должна быть внутри исходного видео; координаты и размеры — чётные целые числа.`);
    }
    return [name, Object.fromEntries(coordinates.map((key) => [key, rect[key]]))];
  }));
}
const even = (value) => Math.round(value / 2) * 2;
export function clampRect(rect, source) {
  const widthLimit = Math.floor(source.width / 2) * 2, heightLimit = Math.floor(source.height / 2) * 2;
  const x = Math.max(0, Math.min(widthLimit - 2, even(rect.x)));
  const y = Math.max(0, Math.min(heightLimit - 2, even(rect.y)));
  return { x, y, width: Math.max(2, Math.min(widthLimit - x, even(rect.width))), height: Math.max(2, Math.min(heightLimit - y, even(rect.height))) };
}
export function sourcePoint(clientX, clientY, bounds, source) {
  return { x: Math.max(0, Math.min(source.width, (clientX - bounds.left) / bounds.width * source.width)),
    y: Math.max(0, Math.min(source.height, (clientY - bounds.top) / bounds.height * source.height)) };
}
export function defaultComposition(layout, source) {
  const rect = (x, y, width, height) => clampRect({ x: x * source.width, y: y * source.height, width: width * source.width, height: height * source.height }, source);
  if (layout === 'duo') return { first: rect(0, 0, .5, 1), second: rect(.5, 0, .5, 1) };
  if (layout === 'slide-speaker') return { slide: rect(0, 0, .75, 1), speaker: rect(.75, .25, .25, .75) };
  return { heading: rect(0, 0, .75, .16), slide: rect(0, .16, .75, .84), speaker: rect(.75, .25, .25, .75) };
}
// Integer/even rectangles make Canvas and FFmpeg use the same exact crop and padding.
function fitRect(rect, width, height, cover, alignX = .5) {
  if (cover) {
    // Trim extreme aspect ratios before upscaling, so a 2-pixel-wide selection
    // cannot request an enormous intermediate frame from the encoder.
    const input = { ...rect };
    if (rect.width / rect.height > width / height) {
      input.width = Math.min(rect.width, Math.max(2, even(rect.height * width / height)));
      input.x += Math.min(rect.width - input.width, even((rect.width - input.width) * alignX));
    } else {
      input.height = Math.min(rect.height, Math.max(2, even(rect.width * height / width)));
      input.y += Math.min(rect.height - input.height, even((rect.height - input.height) / 2));
    }
    const scale = Math.max(width / input.width, height / input.height);
    const scaled = { width: Math.ceil(input.width * scale / 2) * 2, height: Math.ceil(input.height * scale / 2) * 2 };
    const offset = { x: Math.min(scaled.width - width, even((scaled.width - width) * alignX)), y: Math.min(scaled.height - height, even((scaled.height - height) / 2)) };
    return {
      source: { x: input.x + offset.x / scaled.width * input.width, y: input.y + offset.y / scaled.height * input.height, width: width / scaled.width * input.width, height: height / scaled.height * input.height },
      target: { x: 0, y: 0, width, height },
      encode: { input, scaled, offset },
    };
  }
  const crop = { ...rect };
  const scale = Math.min(width / crop.width, height / crop.height);
  const w = cover ? width : Math.min(width, Math.max(2, even(crop.width * scale)));
  const h = cover ? height : Math.min(height, Math.max(2, even(crop.height * scale)));
  return { source: crop, target: { x: even((1080 - w) / 2), y: even((height - h) / 2), width: w, height: h } };
}
export function renderPlan(source, clip) {
  const layout = clip.layout || 'fit';
  let definitions, composition, captionY = null;
  if (compositeLayout(layout)) {
    composition = validateRegions(clip.composition, source, layout);
    if (layout === 'duo') { definitions = [['first', 840, 1080, true], ['second', 840, 840, true]]; captionY = 960; }
    else if (layout === 'slide-speaker') { definitions = [['slide', 810, 1050, false], ['speaker', 870, 870, true]]; captionY = 930; }
    else { definitions = [['heading', 180, 180, false, 1000], ['slide', 540, 780, false], ['speaker', 960, 960, true]]; captionY = 840; }
  } else {
    if (!['fit', 'crop'].includes(layout)) throw new Error('Выберите способ кадрирования.');
    composition = { full: { x: 0, y: 0, width: Math.floor(source.width / 2) * 2, height: Math.floor(source.height / 2) * 2 } };
    definitions = [['full', 1920, 1920, layout === 'crop']];
  }
  let y = 0;
  const blocks = definitions.map(([key, contentHeight, height, cover, width = 1080]) => {
    const mapping = fitRect(composition[key], width, contentHeight, cover, layout === 'crop' ? clip.cropX ?? .5 : .5);
    const block = { key, ...mapping, y, height, background: layout === 'presentation' ? key === 'heading' ? '#151913' : '#161a22' : '#101820' };
    y += height;
    return block;
  });
  return { width: 1080, height: 1920, blocks, captionY };
}
