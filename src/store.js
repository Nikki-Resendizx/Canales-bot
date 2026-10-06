const DEFAULT = {
  text: '{contenido}',
  photo: '{contenido}',
  video: '{contenido}',
  album: '{contenido}',
  link: '{contenido}',
  forwarded: '{contenido}'
};

export function createStore() {
  return { channels: {}, global: { templates: { ...DEFAULT }, hashtags: [], buttons: [] } };
}

export function ensureChannel(store, id, title = '') {
  const key = String(id);
  if (!store.channels[key]) {
    store.channels[key] = {
      id: key, title, enabled: true,
      templates: { ...store.global.templates },
      hashtags: [], buttons: []
    };
  } else if (title) {
    store.channels[key].title = title;
  }
  return store.channels[key];
}
