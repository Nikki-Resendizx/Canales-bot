import { ensureChannel } from './store.js';

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const FORMATS = ['AUTO', 'HTML', 'Markdown', 'MarkdownV2', 'rich_message', 'Telegram', 'OFF'];

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

function hasHtml(text) {
  return /<\/?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|span|a|code|pre|tg-emoji|tg-time|details|blockquote|mark|sub|sup)(?:\s[^>]*)?>/i.test(text);
}

function hasRichMarkdown(text) {
  return /(^|\n)#{1,6}\s+|\*\*|==[^=]+==|!\[[^\]]*\]\(|<tg-|<details\b|<tg-button-row\b|\|.+\|/i.test(text);
}

function hasMarkdownV2(text) {
  return /(^|[^\\])(?:\*[^*\n]+\*|_[^_\n]+_|__[^_\n]+__|~[^~\n]+~|\|\|[^|\n]+\|\||\[[^\]]+\]\([^\n)]+\)|\x60\x60\x60)/.test(text);
}

function hasLegacyMarkdown(text) {
  return /(^|[^\\])(?:\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^\n)]+\))/.test(text);
}

function detectFormat(text) {
  const value = String(text || '');

  // rich_message soporta Markdown enriquecido y HTML compatible en el mismo contenido.
  if (hasRichMarkdown(value) || (hasHtml(value) && (value.includes('**') || value.includes('__') || value.includes('~~')))) {
    return 'rich_message';
  }

  if (hasHtml(value)) return 'HTML';
  if (hasMarkdownV2(value)) return 'MarkdownV2';
  if (hasLegacyMarkdown(value)) return 'Markdown';
  return 'OFF';
}

function formatFor(channel, type) {
  const value = channel.formats?.[type] || 'AUTO';
  return FORMATS.includes(value) ? value : 'AUTO';
}

function originalEntities(msg, originalText, finalText) {
  if (finalText !== originalText) return null;
  return msg.text ? msg.entities : msg.caption_entities;
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

      return { button, row: Number.isInteger(Number(b.row)) ? Number(b.row) : 0 };
    })
    .filter(Boolean);

  if (!rows.length) return undefined;

  const grouped = [];
  for (const item of rows) {
    if (!grouped[item.row]) grouped[item.row] = [];
    grouped[item.row].push(item.button);
  }

  return { inline_keyboard: grouped.filter(Boolean) };
}

function editOptions(channel, msg, originalText, finalText, type) {
  const configured = formatFor(channel, type);
  const mode = configured === 'AUTO' ? detectFormat(finalText) : configured;
  const options = {};
  const markup = buildMarkup(channel);

  if (markup) options.reply_markup = markup;

  if (mode === 'HTML' || mode === 'Markdown' || mode === 'MarkdownV2') {
    options.parse_mode = mode;
  } else if (mode === 'Telegram') {
    const entities = originalEntities(msg, originalText, finalText);
    if (entities) options.entities = entities;
  } else if (mode === 'rich_message') {
    options.rich_message = { markdown: finalText };
  }

  return { options, mode };
}

async function applyEdit(ctx, msg, text, options) {
  if (options.rich_message) {
    const payload = {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      rich_message: options.rich_message
    };

    if (options.reply_markup) payload.reply_markup = options.reply_markup;

    return msg.text
      ? ctx.telegram.callApi('editMessageText', payload)
      : ctx.telegram.callApi('editMessageCaption', payload);
  }

  if (msg.text) {
    return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text || '', options);
  }

  if (msg.photo || msg.video) {
    return ctx.telegram.editMessageCaption(msg.chat.id, msg.message_id, undefined, text || '', options);
  }

  return null;
}

async function editOne(ctx, msg) {
  const channel = ensureChannel(ctx.store, msg.chat.id, msg.chat.title);
  if (!channel.enabled) return;

  const originalText = contentOf(msg);
  const type = typeOf(msg);
  const text = render(channel, type, msg);
  const { options, mode } = editOptions(channel, msg, originalText, text, type);

  try {
    if (!text && !options.reply_markup && !options.rich_message) return;
    await applyEdit(ctx, msg, text, options);
    store.stats.processed += 1;
    console.log('[EDIT]', msg.chat.id, msg.message_id, 'format=' + mode);
  } catch (err) {
    store.stats.errors += 1;
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
      await applyEdit(ctxs[0], msg, text, options);
      store.stats.processed += 1;
      console.log('[ALBUM EDIT]', msg.chat.id, msg.message_id, 'format=' + mode);
    }
  } catch (err) {
    store.stats.errors += 1;
    console.error('[ALBUM EDIT]', err.description || err.message);
  }
}

export function registerPosts(bot, store) {
  const processed = new Set();
  const MAX_PROCESSED = 5000;

  function markProcessed(id) {
    if (processed.has(id)) return false;
    processed.add(id);
    if (processed.size > MAX_PROCESSED) processed.delete(processed.values().next().value);
    return true;
  }

  bot.use((ctx, next) => {
    ctx.store = store;
    return next();
  });

  const albums = new Map();

  bot.on('channel_post', async ctx => {
    const msg = ctx.channelPost;
    const messageKey = String(msg.chat.id) + ':' + String(msg.message_id);
    if (!markProcessed(messageKey)) return;

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
