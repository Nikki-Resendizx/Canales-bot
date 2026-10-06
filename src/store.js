import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT = {
  text: '{contenido}',
  photo: '{contenido}',
  video: '{contenido}',
  album: '{contenido}',
  link: '{contenido}',
  forwarded: '{contenido}'
};

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const DATA_FILE = path.join(DATA_DIR, 'channels.json');

function emptyStore() {
  return {
    channels: {},
    global: { templates: { ...DEFAULT }, hashtags: [], buttons: [] }
  };
}

export function createStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...emptyStore(),
      ...parsed,
      channels: parsed.channels || {},
      global: {
        ...emptyStore().global,
        ...(parsed.global || {}),
        templates: { ...DEFAULT, ...(parsed.global?.templates || {}) }
      }
    };
  } catch (err) {
    console.error('[STORE] No se pudo cargar data/channels.json:', err.message);
    return emptyStore();
  }
}

export function saveStore(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = DATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(temp, DATA_FILE);
  } catch (err) {
    console.error('[STORE] No se pudo guardar la configuración:', err.message);
  }
}

export function ensureChannel(store, id, title = '') {
  const key = String(id);
  let changed = false;

  if (!store.channels[key]) {
    store.channels[key] = {
      id: key,
      title,
      enabled: true,
      templates: { ...store.global.templates },
      hashtags: [],
      buttons: []
    };
    changed = true;
  } else if (title && store.channels[key].title !== title) {
    store.channels[key].title = title;
    changed = true;
  }

  if (changed) saveStore(store);
  return store.channels[key];
}
