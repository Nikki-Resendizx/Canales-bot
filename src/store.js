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

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const DATA_FILE = path.join(DATA_DIR, 'channels.json');

function emptyStore() {
  return {
    channels: {},
    publications: {},
    purchases: {},
    alerts: [],
    stats: { processed: 0, errors: 0, payments: 0, stars: 0 },
    global: {
      templates: { ...DEFAULT },
      hashtags: [],
      buttons: [],
      formats: Object.fromEntries(Object.keys(DEFAULT).map(type => [type, 'AUTO'])),
      normalize: true,
      adminIds: []
    }
  };
}

function normalizeChannel(channel, global) {
  channel.templates = { ...global.templates, ...(channel.templates || {}) };
  channel.hashtags = Array.isArray(channel.hashtags) ? channel.hashtags : [];
  channel.buttons = Array.isArray(channel.buttons) ? channel.buttons : [];
  const legacy = channel.parse_mode && ['HTML', 'Markdown', 'MarkdownV2', 'OFF'].includes(channel.parse_mode) ? channel.parse_mode : null;
  channel.formats = { ...(global.formats || {}), ...(channel.formats || {}) };
  for (const type of Object.keys(DEFAULT)) if (!['AUTO', 'HTML', 'Markdown', 'MarkdownV2', 'rich_message', 'Telegram', 'OFF'].includes(channel.formats[type])) channel.formats[type] = legacy || 'AUTO';
  channel.normalize = channel.normalize !== false;
  channel.testMode = channel.testMode === true;
  if (typeof channel.enabled !== 'boolean') channel.enabled = true;
  return channel;
}

export function createStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('La raíz del archivo no es un objeto.');
    if (parsed.channels != null && (typeof parsed.channels !== 'object' || Array.isArray(parsed.channels))) throw new Error('La lista de canales no es válida.');
    if (parsed.global != null && (typeof parsed.global !== 'object' || Array.isArray(parsed.global))) throw new Error('La configuración global no es válida.');
    for (const field of ['publications', 'purchases', 'stats']) {
      if (parsed[field] != null && (typeof parsed[field] !== 'object' || Array.isArray(parsed[field]))) {
        throw new Error('El campo ' + field + ' no tiene una estructura válida.');
      }
    }
    const base = emptyStore();
    const global = {
      ...base.global,
      ...(parsed.global || {}),
      templates: { ...DEFAULT, ...(parsed.global?.templates || {}) },
      formats: { ...base.global.formats, ...(parsed.global?.formats || {}) },
      adminIds: Array.isArray(parsed.global?.adminIds) ? parsed.global.adminIds.map(String) : []
    };
    const channels = parsed.channels || {};
    const publications = parsed.publications || {};
    const purchases = parsed.purchases || {};
    const alerts = Array.isArray(parsed.alerts) ? parsed.alerts.slice(-100) : [];
    const stats = { ...base.stats, ...(parsed.stats || {}) };

    for (const key of Object.keys(channels)) {
      if (!channels[key] || typeof channels[key] !== 'object' || Array.isArray(channels[key])) {
        throw new Error('El canal ' + key + ' no tiene una estructura válida.');
      }
      channels[key] = normalizeChannel(channels[key], global);
    }

    return { channels, publications, purchases, alerts, stats, global };
  } catch (err) {
    console.error('[STORE] No se pudo cargar data/channels.json:', err.message);
    try {
      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now());
        console.error('[STORE] Se conservó una copia del archivo dañado para recuperación.');
      }
    } catch (backupError) {
      console.error('[STORE] No pude preservar el archivo dañado:', backupError.message);
    }
    return emptyStore();
  }
}

export function saveStore(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = DATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(temp, DATA_FILE);
    return true;
  } catch (err) {
    console.error('[STORE] No se pudo guardar la configuración:', err.message);
    return false;
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
      testMode: false,
      templates: { ...store.global.templates },
      hashtags: [],
      buttons: [],
      formats: { ...store.global.formats },
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

export function recordAlert(store, type, message, details = {}) {
  if (!Array.isArray(store.alerts)) store.alerts = [];
  store.alerts.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: String(type || 'info').slice(0, 40),
    message: String(message || '').slice(0, 500),
    details,
    at: new Date().toISOString()
  });
  if (store.alerts.length > 100) store.alerts.splice(0, store.alerts.length - 100);
  saveStore(store);
}
