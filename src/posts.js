import { ensureChannel, recordAlert, saveStore } from './store.js';

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const FORMATS = ['AUTO', 'HTML', 'Markdown', 'MarkdownV2', 'rich_message', 'Telegram', 'OFF'];

function typeOf(msg) {
  if (msg.media_group_id) return 'album';
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) return 'forwarded';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
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

export function render(channel, type, msg) {
  let content = contentOf(msg);
  if (channel.normalize) content = normalize(content);

  const template = channel.templates?.[type] || '{contenido}';
  const hashtags = (channel.hashtags || []).join(' ');
  const values = {
    contenido: content,
    titulo: firstLine(content),
    descripcion: descriptionOf(content),
    enlace: linkOf(content),
    hashtags,
    fecha: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
    canal: msg.chat?.title || channel.title || ''
  };

  let text = template.replace(/\{(contenido|titulo|descripcion|enlace|hashtags|fecha|canal)\}/g, (_, name) => values[name] ?? '');
  const missingHashtags = (channel.hashtags || []).filter(tag => tag && !text.includes(tag));
  if (missingHashtags.length) text += '\n\n' + missingHashtags.join(' ');
  return text.trim();
}

function hasHtml(text) {
  return /<\/?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|span|a|code|pre|tg-emoji|tg-time|details|blockquote|mark|sub|sup)(?:\s[^>]*)?>/i.test(text);
}

function hasRichMarkdown(text) {
  return /(^|\n)#{1,6}\s+|\*\*|==[^=]+==|!\[[^\]]*\]\(|<details\b|<tg-time\b|<tg-button-row\b|\|.+\|/i.test(text);
}

function hasMarkdownV2(text) {
  return /(^|[^\\])(?:__[^_\n]+__|~[^~\n]+~|\|\|[^|\n]+\|\||\x60\x60\x60|\\\\[.!#$%&()+\-=<>@\[\]{}])/m.test(text);
}

function hasLegacyMarkdown(text) {
  return /(^|[^\\])(?:\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^\n)]+\))/.test(text);
}

export function detectFormat(text) {
  const value = String(text || '');
  if (hasRichMarkdown(value)) return 'rich_message';
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
  const entities = msg.text ? msg.entities : msg.caption_entities;
  if (!Array.isArray(entities) || !entities.length) return null;
  const rawText = String(msg.text || msg.caption || '');
  const leadingTrim = rawText.length - rawText.trimStart().length;
  const start = String(finalText || '').indexOf(originalText);
  if (start < 0) return null;
  const shift = start - leadingTrim;
  return entities.map(entity => ({
    ...entity,
    offset: Math.max(0, Number(entity.offset || 0) + shift)
  }));
}

function buildMarkup(channel) {
  const buttons = Array.isArray(channel.buttons) ? channel.buttons : [];
  if (!buttons.length) return undefined;

  const rows = buttons.map((item) => {
    if (!item || !item.text) return null;
    const button = { text: String(item.text) };
    if (['primary', 'success', 'danger'].includes(String(item.style || '').toLowerCase())) {
      button.style = String(item.style).toLowerCase();
    }
    if (item.icon_custom_emoji_id) button.icon_custom_emoji_id = String(item.icon_custom_emoji_id);

    if (item.type === 'url' && /^https?:\/\//i.test(String(item.url || ''))) button.url = item.url;
    else if (item.type === 'callback' && item.callback_data && Buffer.byteLength(String(item.callback_data), 'utf8') <= 64) {
      button.callback_data = String(item.callback_data);
    } else return null;

    const row = Number(item.row);
    return { button, row: Number.isInteger(row) && row >= 0 ? Math.min(row, 99) : 0 };
  }).filter(Boolean);

  const grouped = [];
  for (const item of rows) {
    if (!grouped[item.row]) grouped[item.row] = [];
    grouped[item.row].push(item.button);
  }
  return grouped.some(Boolean) ? { inline_keyboard: grouped.filter(Boolean) } : undefined;
}

export function editOptions(channel, msg, originalText, finalText, type) {
  const configured = formatFor(channel, type);
  const nativeEntities = originalEntities(msg, originalText, finalText);
  const mode = configured === 'AUTO'
    ? (nativeEntities?.length ? 'Telegram' : detectFormat(finalText))
    : configured;
  const options = {};
  const markup = buildMarkup(channel);
  if (markup) options.reply_markup = markup;

  if (mode === 'HTML' || mode === 'Markdown' || mode === 'MarkdownV2') {
    options.parse_mode = mode;
  } else if (mode === 'Telegram') {
    const entities = originalEntities(msg, originalText, finalText);
    if (entities?.length) options.entities = entities;
  } else if (mode === 'rich_message' && msg.text) {
    // Telegram Rich Messages support text edits, not caption edits.
    options.rich_message = { markdown: finalText };
  }
  return { options, mode };
}

async function applyEdit(ctx, msg, text, options) {
  if (options.rich_message && msg.text) {
    const payload = {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      rich_message: options.rich_message
    };
    if (options.reply_markup) payload.reply_markup = options.reply_markup;
    return ctx.telegram.callApi('editMessageText', payload);
  }

  if (msg.text) {
    return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text || '', options);
  }

  const isMedia = msg.photo || msg.video || msg.animation || msg.audio || msg.document;
  if (isMedia) {
    return ctx.telegram.editMessageCaption(msg.chat.id, msg.message_id, undefined, text || '', options);
  }
  return null;
}

function isNotModifiedError(err) {
  return /message is not modified/i.test(String(err?.description || err?.message || ''));
}

function isFormattingError(err) {
  const message = String(err?.description || err?.message || '').toLowerCase();
  return /parse entities|can't parse|cannot parse|unsupported start tag|rich.?message|entities.*invalid|message text is empty/.test(message);
}

async function editWithFallback(ctx, msg, text, options) {
  try {
    return await applyEdit(ctx, msg, text, options);
  } catch (err) {
    if (!isFormattingError(err)) throw err;
    // A malformed template should not permanently prevent editing the post.
    // Retry once as plain text while preserving the configured inline keyboard.
    const fallback = {};
    if (options.reply_markup) fallback.reply_markup = options.reply_markup;
    console.warn('[EDIT FORMAT FALLBACK]', err.description || err.message);
    return applyEdit(ctx, msg, text, fallback);
  }
}

async function sendTestPreview(ctx, store, msg, type, text) {
  const admins = String(process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const preview = '🧪 VISTA PREVIA — MODO PRUEBA\n\n📢 Canal: ' + (msg.chat?.title || msg.chat?.id) +
    '\n🆔 Mensaje: ' + msg.message_id +
    '\n📦 Tipo: ' + type.toUpperCase() +
    '\n\n' + (text || '[Sin texto]');
  let delivered = 0;
  for (const adminId of admins) {
    try {
      await ctx.telegram.sendMessage(adminId, preview);
      delivered += 1;
    } catch (err) {
      console.error('[TEST PREVIEW]', adminId, err.description || err.message);
    }
  }
  if (delivered) {
    store.stats.processed += 1;
    saveStore(store);
  } else {
    store.stats.errors += 1;
    recordAlert(store, 'test-preview', 'No se pudo enviar la vista previa a ningún administrador.', { chatId: msg.chat?.id, messageId: msg.message_id });
    saveStore(store);
  }
}

async function editOne(ctx, msg, store) {
  const channel = ensureChannel(ctx.store, msg.chat.id, msg.chat.title);
  if (!channel.enabled) return;

  const originalText = contentOf(msg);
  const type = typeOf(msg);
  const text = render(channel, type, msg);
  if (channel.testMode) {
    await sendTestPreview(ctx, store, msg, type, text);
    return;
  }

  const { options, mode } = editOptions(channel, msg, originalText, text, type);
  try {
    if ((msg.text && !text) || (!text && !options.reply_markup && !options.rich_message)) return;
    await editWithFallback(ctx, msg, text, options);
    store.stats.processed += 1;
    saveStore(store);
    console.log('[EDIT]', msg.chat.id, msg.message_id, 'format=' + mode);
  } catch (err) {
    if (isNotModifiedError(err)) return;
    store.stats.errors += 1;
    saveStore(store);
    console.error('[EDIT]', msg.chat.id, msg.message_id, err.description || err.message);
    recordAlert(store, 'edit', err.description || err.message, { chatId: msg.chat.id, messageId: msg.message_id });
  }
}

async function processAlbum(ctxs, store) {
  if (!ctxs.length) return;
  const first = ctxs[0].channelPost;
  const captioned = ctxs.find(ctx => contentOf(ctx.channelPost));
  const target = captioned || ctxs[0];
  const msg = target.channelPost;
  const channel = ensureChannel(ctxs[0].store, first.chat.id, first.chat.title);
  if (!channel.enabled) return;

  const originalText = contentOf(msg);
  const text = render(channel, 'album', msg);
  if (channel.testMode) {
    await sendTestPreview(ctxs[0], store, msg, 'album', text);
    return;
  }

  const { options, mode } = editOptions(channel, msg, originalText, text, 'album');
  try {
    if (msg.photo || msg.video || msg.audio || msg.document) {
      await editWithFallback(ctxs[0], msg, text, options);
      store.stats.processed += 1;
      saveStore(store);
      console.log('[ALBUM EDIT]', msg.chat.id, msg.message_id, 'format=' + mode);
    }
  } catch (err) {
    if (isNotModifiedError(err)) return;
    store.stats.errors += 1;
    saveStore(store);
    console.error('[ALBUM EDIT]', msg.chat.id, msg.message_id, err.description || err.message);
    recordAlert(store, 'album-edit', err.description || err.message, { chatId: msg.chat.id, messageId: msg.message_id });
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
      const albumKey = String(msg.chat.id) + ':' + msg.media_group_id;
      const current = albums.get(albumKey) || [];
      current.push(ctx);
      albums.set(albumKey, current);
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        const batch = albums.get(albumKey);
        albums.delete(albumKey);
        if (batch) processAlbum(batch, store).catch(err => console.error('[ALBUM PROCESS]', err));
      }, 1200);
      return;
    }
    await editOne(ctx, msg, store);
  });
}
