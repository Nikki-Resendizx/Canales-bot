import test from 'node:test';
import assert from 'node:assert/strict';
import { parseButtonSyntax } from './button-syntax.js';

test('parses one button per row and multiple buttons joined with &&', () => {
  const result = parseButtonSyntax([
    'Texto de publicación',
    'Visitar - t.me/ejemplo',
    'Canal A - t.me/a && Canal B - https://t.me/b'
  ].join('\n'));

  assert.equal(result.text, 'Texto de publicación');
  assert.equal(result.keyboard.length, 2);
  assert.equal(result.keyboard[0].length, 1);
  assert.equal(result.keyboard[1].length, 2);
  assert.equal(result.keyboard[0][0].url, 'https://t.me/ejemplo');
});

test('maps #p, #r and #g to Telegram button styles', () => {
  const result = parseButtonSyntax([
    '#p Azul - t.me/a',
    '#r Rojo - t.me/b',
    '#g Verde - t.me/c'
  ].join('\n'));

  assert.deepEqual(result.keyboard.map(row => row[0].style), ['primary', 'danger', 'success']);
});

test('supports popup, alert, share and copy special buttons', () => {
  const result = parseButtonSyntax([
    'Aviso - popup:Hola',
    'Alerta - alert:Importante',
    'Compartir - share:Hola mundo',
    'Copiar - copy:Texto copiable'
  ].join('\n'));

  assert.equal(result.keyboard.length, 4);
  assert.ok(result.keyboard[0][0].callback_data.startsWith('sp'));
  assert.ok(result.actions.has(result.keyboard[0][0].callback_data));
  assert.ok(result.keyboard[1][0].callback_data.startsWith('sp'));
  assert.match(result.keyboard[2][0].url, /^https:\/\/t\.me\/share\/url\?text=/);
  assert.deepEqual(result.keyboard[3][0].copy_text, { text: 'Texto copiable' });
});

test('uses configured rules URL and leaves rules line as text if not configured', () => {
  const previous = process.env.CHANNEL_RULES_URL;
  process.env.CHANNEL_RULES_URL = 'https://example.com/rules';
  try {
    const result = parseButtonSyntax('Reglas - rules');
    assert.equal(result.keyboard[0][0].url, 'https://example.com/rules');
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_RULES_URL;
    else process.env.CHANNEL_RULES_URL = previous;
  }
});
