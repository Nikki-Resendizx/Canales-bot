import { ensureChannel } from './store.js';

function typeOf(msg) {
  if (msg.media_group_id) return 'album';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.forward_origin) return 'forwarded';

  const text = msg.text || msg.caption || '';
  const hasUrl = text.includes('http://') || text.includes('https://');
  return hasUrl ? 'link' : 'text';
}

function contentOf(msg) {
  return String(msg.text || msg.caption || '').trim();
}

function render(channel, type, msg) {
  let text = contentOf(msg);
  text = text.split('\t').join(' ').trim();

  while (text.includes('\n\n\n')) {
    text = text.replaceAll('\n\n\n', '\n\n');
  }

  const template = channel.templates[type] || '{contenido}';
  text = template.replaceAll('{contenido}', text);

  if (channel.hashtags.length) {
    text += '\n\n' + channel.hashtags.join(' ');
  }

  return text.trim();
}

async function editOne(ctx, msg) {
  const channel = ensureChannel(ctx.store, msg.chat.id, msg.chat.title);
  if (!channel.enabled) return;

  const type = typeOf(msg);
  const text = render(channel, type, msg);

  try {
    const markup = channel.buttons.length
      ? { inline_keyboard: channel.buttons }
      : undefined;

    if (msg.text) {
      if (!text) return;
      await ctx.telegram.editMessageText(
        msg.chat.id,
        msg.message_id,
        undefined,
        text,
        { reply_markup: markup }
      );
      return;
    }

    if (msg.photo || msg.video) {
      if (!text && !markup) return;
      await ctx.telegram.editMessageCaption(
        msg.chat.id,
        msg.message_id,
        undefined,
        text || '',
        { reply_markup: markup }
      );
    }
  } catch (err) {
    console.error('[EDIT]', err.description || err.message);
  }
}

async function processAlbum(ctxs) {
  if (!ctxs.length) return;

  const first = ctxs[0].channelPost;
  const captioned = ctxs.find((ctx) => contentOf(ctx.channelPost));
  const target = captioned || ctxs[0];

  const channel = ensureChannel(ctxs[0].store, first.chat.id, first.chat.title);
  if (!channel.enabled) return;

  const msg = target.channelPost;
  const text = render(channel, 'album', msg);

  try {
    const markup = channel.buttons.length
      ? { inline_keyboard: channel.buttons }
      : undefined;

    if (msg.photo || msg.video) {
      await ctxs[0].telegram.editMessageCaption(
        msg.chat.id,
        msg.message_id,
        undefined,
        text || '',
        { reply_markup: markup }
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

  bot.on('channel_post', async (ctx) => {
    const msg = ctx.channelPost;

    if (msg.media_group_id) {
      const key = String(msg.chat.id) + ':' + msg.media_group_id;
      const current = albums.get(key) || [];
      current.push(ctx);
      albums.set(key, current);

      clearTimeout(current.timer);

      const timer = setTimeout(() => {
        const batch = albums.get(key);
        albums.delete(key);
        if (batch) processAlbum(batch).catch(console.error);
      }, 1200);

      current.timer = timer;
      return;
    }

    await editOne(ctx, msg);
  });
}
