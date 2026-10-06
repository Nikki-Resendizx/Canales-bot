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
    global: {
      templates: { ...DEFAULT },
      hashtags: [],
      buttons: [],
      parse_mode: 'HTML',
      normalize: true
    }
  };
}

function normalizeChannel(channel, global) {
  channel.templates = { ...global.templates, ...(channel.templates || {}) };
  channel.hashtags = Array.isArray(channel.hashtags) ? channel.hashtags : [];
  channel.buttons = Array.isArray(channel.buttons) ? channel.buttons : [];
  channel.parse_mode = channel.parse_mode || global.parse_mode || 'HTML';
  channel.normalize = channel.normalize !== false;
  if (typeof channel.enabled !== 'boolean') channel.enabled = true;
  return channel;
}

export function createStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = emptyStore();
    const global = {
      ...base.global,
      ...(parsed.global || {}),
      templates: { ...DEFAULT, ...(parsed.global?.templates || {}) }
    };
    const channels = parsed.channels || {};

    for (const key of Object.keys(channels)) {
      channels[key] = normalizeChannel(channels[key], global);
    }

    return { channels, global };
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
    store.channels[key] = normalizeChannel({
      id: key,
      title,
      enabled: true,
      templates: { ...store.global.templates },
      hashtags: [],
      buttons: [],
      parse_mode: store.global.parse_mode,
      normalize: store.global.normalize
    }, store.global);
    changed = true;
  } else {
    const c = store.channels[key];
    normalizeChannel(c, store.global);
    if (title && c.title !== title) {
      c.title = title;
      changed = true;
    }
  }

  if (changed) saveStore(store);
  return store.channels[key];
}

export { DEFAULT };
