import { ensureChannel } from './store.js';

const URL_RE = /https?:\/\/[^\s<>"']+/i;

function typeOf(msg) {
  if (msg.media_group_id) return 'album';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.forward_origin) return 'forwarded';

  const text = msg.text || msg.caption || '';
  return URL_RE.test(text) ? 'link' : 'text';
}

function contentOf(msg) {
  return String(msg.text || msg.caption || '').trim();
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/)[0].trim();
}

function descriptionOf(text) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return lines.slice(1).join('\n');
}

function linkOf(text) {
  const match = String(text || '').match(URL_RE);
  return match ? match[0] : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalize(text) {
  let value = String(text ?? '').replaceAll('\t', ' ').trim();
  while (value.includes('\n\n\n')) value = value.replaceAll('\n\n\n', '\n\n');
  return value;
}

function render(channel, type, msg) {
  let content = contentOf(msg);
  if (channel.normalize) content = normalize(content);

  const template = channel.templates[type] || '{contenido}';
  const hashtags = channel.hashtags.join(' ');
  const values = {
    contenido: content,
    titulo: firstLine(content),
    descripcion: descriptionOf(content),
    enlace: linkOf(content),
    hashtags,
    fecha: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
    canal: msg.chat?.title || channel.title || ''
  };

  let text = template.replace(/\{(contenido|titulo|descripcion|enlace|hashtags|fecha|canal)\}/g, (_, key) => values[key] ?? '');

  if (hashtags && !text.includes(hashtags)) text += '\n\n' + hashtags;
  return text.trim();
}

function buildMarkup(channel) {
  if (!channel.buttons.length) return undefined;

  const rows = channel.buttons
    .filter(b => b && b.text)
    .map(b => {
      const button = { text: String(b.text) };
      if (b.style) button.style = b.style;
      if (b.icon_custom_emoji_id) button.icon_custom_emoji_id = String(b.icon_custom_emoji_id);

      if (b.type === 'url' && b.url) button.url = b.url;
      else if (b.type === 'callback' && b.callback_data) button.callback_data = b.callback_data;
      else return null;

      return button;
    })
    .filter(Boolean);

  if (!rows.length) return undefined;
  const grouped = [];
  for (const button of rows) {
    const row = channel.buttons.find(b => b.text === button.text)?.row ?? 0;
    if (!grouped[row]) grouped[row] = [];
    grouped[row].push(button);
  }

  return { inline_keyboard: grouped.filter(Boolean) };
}

function originalEntities(msg, originalText, finalText, channel) {
  if (channel.parse_mode !== 'OFF') return null;
  if (finalText !== originalText) return null;
  return msg.text ? msg.entities : msg.caption_entities;
}

function editOptions(channel, msg, originalText, finalText, type) {
  const configured = formatFor(channel, type);
  const mode = configured === 'AUTO' ? detectFormat(finalText) : configured;
  const options = {};
  const markup = buildMarkup(channel);
  if (markup) options.reply_markup = markup;

  if (channel.parse_mode === 'HTML') options.parse_mode = 'HTML';
  else if (channel.parse_mode === 'MarkdownV2') options.parse_mode = 'MarkdownV2';
  else if (channel.parse_mode === 'OFF') {
    const entities = originalEntities(msg, originalText, finalText, channel);
    if (entities) options.entities = entities;
  }

  return options;
}

async function editOne(ctx, msg) {
  const channel = ensureChannel(ctx.store, msg.chat.id, msg.chat.title);
  if (!channel.enabled) return;

  const originalText = contentOf(msg);
  const text = render(channel, typeOf(msg), msg);
  const { options, mode } = editOptions(channel, msg, originalText, text, type);

  try {
    if (msg.text) {
      if (!text && !options.reply_markup) return;
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text || '', options);
      return;
    }

    if (msg.photo || msg.video) {
      if (!text && !options.reply_markup) return;
      await ctx.telegram.editMessageCaption(msg.chat.id, msg.message_id, undefined, text || '', options);
    }
  } catch (err) {
    console.error('[EDIT]', err.description || err.message);
  }
}

async function processAlbum(ctxs) {
  if (!ctxs.length) return;

  const first = ctxs[0].channelPost;
  const captioned = ctxs.find(ctx => contentOf(ctx.channelPost));
  const target = captioned || ctxs[0];
  const msg = target.channelPost;

  const channel = ensureChannel(ctxs[0].store, first.chat.id, first.chat.title);
  if (!channel.enabled) return;

  const originalText = contentOf(msg);
  const text = render(channel, 'album', msg);
  const { options, mode } = editOptions(channel, msg, originalText, text, 'album');

  try {
    if (msg.photo || msg.video) {
      await ctxs[0].telegram.editMessageCaption(
        msg.chat.id,
        msg.message_id,
        undefined,
        text || '',
        options
      );
    }
  } catch (err) {
    console.error('[ALBUM EDIT]', err.description || err.message);
  }
}

export function registerPosts(bot, store) {
  bot.use((ctx, next) => {
    ctx.store = store;
    return next();
  });

  const albums = new Map();

  bot.on('channel_post', async ctx => {
    const msg = ctx.channelPost;

    if (msg.media_group_id) {
      const key = String(msg.chat.id) + ':' + msg.media_group_id;
      const current = albums.get(key) || [];
      current.push(ctx);
      albums.set(key, current);

      clearTimeout(current.timer);

      current.timer = setTimeout(() => {
        const batch = albums.get(key);
        albums.delete(key);
        if (batch) processAlbum(batch).catch(console.error);
      }, 1200);
      return;
    }

    await editOne(ctx, msg);
  });
}
