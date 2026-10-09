import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canales-bot-test-'));
process.env.DATA_DIR = dataDir;

const storeModule = await import('./store.js?test=' + Date.now());
const postsModule = await import('./posts.js?test=' + Date.now());

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

test('store creates a channel with safe defaults and persists it', () => {
  const store = storeModule.createStore();
  const channel = storeModule.ensureChannel(store, '-1001234567890', 'Canal de prueba');

  assert.equal(channel.id, '-1001234567890');
  assert.equal(channel.title, 'Canal de prueba');
  assert.equal(channel.enabled, true);
  assert.equal(channel.testMode, false);
  assert.equal(channel.formats.text, 'AUTO');

  const loaded = storeModule.createStore();
  assert.equal(loaded.channels['-1001234567890'].title, 'Canal de prueba');
});

test('store limits operational alerts to the latest 100 records', () => {
  const store = storeModule.createStore();
  for (let i = 0; i < 105; i += 1) {
    storeModule.recordAlert(store, 'test', 'alert-' + i);
  }
  assert.equal(store.alerts.length, 100);
  assert.equal(store.alerts[0].message, 'alert-5');
  assert.equal(store.alerts.at(-1).message, 'alert-104');
});

test('format detection distinguishes HTML, Markdown and plain text', () => {
  assert.equal(postsModule.detectFormat('<b>Hola</b>'), 'HTML');
  assert.equal(postsModule.detectFormat('*Hola*'), 'Markdown');
  assert.equal(postsModule.detectFormat('texto sin formato'), 'OFF');
});

test('templates substitute content fields and append hashtags only once', () => {
  const channel = {
    normalize: true,
    title: 'Canal de prueba',
    hashtags: ['#Prueba'],
    templates: { text: '{titulo}\n{descripcion}\n{enlace}\n{hashtags}' }
  };
  const message = {
    text: 'Título\nDescripción https://example.com',
    chat: { title: 'Canal de prueba' }
  };
  const output = postsModule.render(channel, 'text', message);

  assert.match(output, /^Título\nDescripción https:\/\/example\.com\nhttps:\/\/example\.com\n#Prueba$/);
  assert.equal(output.match(/#Prueba/g)?.length, 1);
});

test('AUTO preserves native Telegram entities when the text is unchanged', () => {
  const channel = {
    normalize: true,
    buttons: [],
    formats: { text: 'AUTO' },
    templates: { text: '{contenido}' },
    hashtags: []
  };
  const entities = [{ type: 'bold', offset: 0, length: 4 }];
  const message = { text: 'Hola', entities };
  const result = postsModule.editOptions(channel, message, 'Hola', 'Hola', 'text');

  assert.equal(result.mode, 'Telegram');
  assert.deepEqual(result.options.entities, entities);
  assert.equal(result.options.parse_mode, undefined);
});

test('AUTO shifts native Telegram entity offsets when a template adds a prefix', () => {
  const channel = {
    normalize: true,
    buttons: [],
    formats: { text: 'AUTO' },
    templates: { text: 'Encabezado\n{contenido}' },
    hashtags: []
  };
  const entities = [{ type: 'bold', offset: 0, length: 4 }];
  const message = { text: 'Hola', entities };
  const result = postsModule.editOptions(channel, message, 'Hola', 'Encabezado\\nHola', 'text');

  assert.equal(result.mode, 'Telegram');
  assert.deepEqual(result.options.entities, [{ type: 'bold', offset: 11, length: 4 }]);
});


test('distribution connections persist and invalid routes are discarded', () => {
  const store = storeModule.createStore();
  store.global.distributionRoutes.push({
    id: 'route-test',
    sourceId: '-1001234567890',
    targetId: '-1001234567891',
    ownerId: '12345',
    mode: 'copy',
    enabled: true
  });
  storeModule.saveStore(store);
  const loaded = storeModule.createStore();
  assert.equal(loaded.global.distributionRoutes.length, 1);
  assert.equal(loaded.global.distributionRoutes[0].mode, 'copy');
  assert.equal(loaded.global.distributionRoutes[0].sourceId, '-1001234567890');
});
