import { compositeLayout } from './ui/composition.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AppError, atomicJSON, DEFAULT_ROOT, readJSON, requireThat, validateComposition } from './core.mjs';

const INPUT_KEYS = ['name', 'sourceSize', 'layout', 'composition'];
const TEMPLATE_KEYS = ['version', 'id', ...INPUT_KEYS, 'createdAt'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

export function validateLayoutTemplate(input) {
  requireThat(exactKeys(input, INPUT_KEYS), 'Нужны только название, размер исходника, компоновка и области шаблона.');
  requireThat(typeof input.name === 'string', 'Укажите название шаблона.');
  const name = input.name.normalize('NFC').trim();
  requireThat(name.length > 0 && name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(name), 'Название шаблона должно содержать от 1 до 120 символов без переносов строк.');
  requireThat(exactKeys(input.sourceSize, ['width', 'height']) && ['width', 'height'].every((key) =>
    Number.isInteger(input.sourceSize[key]) && input.sourceSize[key] > 0 && input.sourceSize[key] <= 32768), 'Укажите корректные ширину и высоту исходного видео.');
  requireThat(compositeLayout(input.layout), 'Сохранить как шаблон можно компоновку «Слайд + ведущий».');
  const sourceSize = { width: input.sourceSize.width, height: input.sourceSize.height };
  return { name, sourceSize, layout: input.layout, composition: validateComposition(input.composition, sourceSize, input.layout) };
}

const templateId = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);

// The local server holds the cache's process lock. This queue serializes template
// writes within that process so simultaneous saves cannot overwrite one another.
export class LayoutTemplateStore {
  constructor(root = DEFAULT_ROOT) {
    this.file = path.join(path.resolve(root), 'layout-templates.json');
    this.queue = Promise.resolve();
  }

  async read() {
    let data;
    try { data = await readJSON(this.file); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new AppError(`Не удалось прочитать шаблоны: ${this.file}. Проверьте файл и восстановите его из копии; он не был перезаписан.`, 500);
    }
    try {
      requireThat(exactKeys(data, ['version', 'templates']) && data.version === 1 && Array.isArray(data.templates), 'Неверный формат хранилища.');
      const ids = new Set();
      return data.templates.map((template) => {
        requireThat(exactKeys(template, TEMPLATE_KEYS) && template.version === 1, 'Неверный формат шаблона.');
        const input = validateLayoutTemplate(Object.fromEntries(INPUT_KEYS.map((key) => [key, template[key]])));
        requireThat(template.id === templateId(input) && !ids.has(template.id), 'Неверный идентификатор шаблона.');
        requireThat(typeof template.createdAt === 'string' && Number.isFinite(Date.parse(template.createdAt)) &&
          new Date(template.createdAt).toISOString() === template.createdAt, 'Неверная дата шаблона.');
        ids.add(template.id);
        return { version: 1, id: template.id, ...input, createdAt: template.createdAt };
      });
    } catch {
      throw new AppError(`Файл шаблонов повреждён или имеет неподдерживаемую версию: ${this.file}. Восстановите его из копии; он не был перезаписан.`, 500);
    }
  }

  async list() {
    await this.queue.catch(() => {});
    return this.read();
  }

  async create(input) {
    // Validate and copy before queuing, so caller mutations cannot affect a save.
    const canonical = validateLayoutTemplate(input);
    const id = templateId(canonical);
    const operation = this.queue.catch(() => {}).then(async () => {
      const templates = await this.read();
      const existing = templates.find((template) => template.id === id);
      if (existing) return { template: existing, created: false };
      const template = { version: 1, id, ...canonical, createdAt: new Date().toISOString() };
      await atomicJSON(this.file, { version: 1, templates: [...templates, template] });
      return { template, created: true };
    });
    this.queue = operation;
    return operation;
  }
}
