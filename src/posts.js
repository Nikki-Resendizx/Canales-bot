import { ensureChannel } from './store.js';

function typeOf(msg) {
  if (msg.media_group_id) return 'album';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.forward_origin) return 'forwarded';
  const text = msg.text || msg.caption || '';
  return /https?:\/\//i.test(text) ? 'link' : 'text';
}

function contentOf(msg) {
  return (msg.text || msg.caption || '').trim();
}

function render(channel, type, msg) {
  let text = contentOf(msg).replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  text = (channel.templates[type] || '{contenido}').replaceAll('{contenido}', text);
  if (channel.hashtags.length) text += '\\n\\n' + channel.hashtags.join(' ');
  return text.trim();
}

async function process(ctx) {
  const msg = ctx.channelPost;
  const channel = ensureChannel(ctx.store, msg.chat.id, msg.chat.title);
  if (!channel.enabled) return;

  const type = typeOf(msg);
  const text = render(channel, type, msg);
  if (!text) return;

  try {
    const markup = channel.buttons.length ? { inline_keyboard: channel.buttons } : undefined;
    if (msg.text) {
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text, { reply_markup: markup });
    } else if (msg.photo || msg.video) {
      await ctx.telegram.editMessageCaption(msg.chat.id, msg.message_id, undefined, text, { reply_markup: markup });
    }
  } catch (err) {
    console.error('[EDIT]', err.description || err.message);
  }
}

export function registerPosts(bot, store) {
  bot.use((ctx, next) => { ctx.store = store; return next(); });
  const timers = new Map();

  bot.on('channel_post', async ctx => {
    const msg = ctx.channelPost;
    if (msg.media_group_id) {
      const key = String(msg.chat.id) + ':' + msg.media_group_id;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        process(ctx).catch(console.error);
      }, 1000));
      return;
    }
    await process(ctx);
  });
}
