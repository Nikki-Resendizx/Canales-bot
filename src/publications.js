import { ensureChannel, recordAlert, saveStore } from './store.js';

function admin(ctx) {
  return String(process.env.ADMIN_IDS || '').split(',').map(value => value.trim()).filter(Boolean).includes(String(ctx.from?.id));
}

function makeId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function registerPublications(bot, store) {
  const sessions = new Map();
  const pendingAlbums = new Map();
  const key = ctx => String(ctx.from.id);

  async function publishContent(ctx, session, messages) {
    const channel = ensureChannel(store, session.channelId);
    const messageIds = messages.map(message => message.message_id).sort((a, b) => a - b);
    const publicationId = makeId();
    const publication = {
      id: publicationId,
      channelId: channel.id,
      channelTitle: channel.title || '',
      mode: session.mode,
      priceStars: session.priceStars || 0,
      sourceChatId: ctx.chat.id,
      sourceMessageId: messageIds[0],
      sourceMessageIds: messageIds,
      mediaGroupId: messages[0]?.media_group_id || null,
      status: 'draft',
      createdAt: new Date().toISOString()
    };

    try {
      // Persist the order before exposing the invoice to avoid a pre-checkout race.
      publication.status = 'published';
      store.publications[publicationId] = publication;
      saveStore(store);

      let sent;
      if (session.mode === 'paid') {
        const botInfo = await ctx.telegram.getMe();
        const buyUrl = 'https://t.me/' + botInfo.username + '?start=buy_' + publicationId;
        sent = await ctx.telegram.sendMessage(
          channel.id,
          '⭐ CONTENIDO PREMIUM\n\nPrecio: ' + session.priceStars + ' Telegram Stars.\n\nPulsa el botón para iniciar la compra de forma segura en privado. El contenido se entrega después de confirmar el pago.',
          { reply_markup: { inline_keyboard: [[{
            text: '⭐ COMPRAR POR ' + session.priceStars + ' STARS',
            url: buyUrl,
            style: 'success'
          }]] } }
        );
      } else if (messageIds.length > 1) {
        sent = await ctx.telegram.copyMessages(channel.id, ctx.chat.id, messageIds);
      } else {
        sent = await ctx.telegram.copyMessage(channel.id, ctx.chat.id, messageIds[0]);
      }

      publication.status = 'published';
      publication.channelMessageId = Array.isArray(sent)
        ? (sent[0]?.message_id || null)
        : (sent?.message_id || null);
      publication.channelMessageIds = Array.isArray(sent)
        ? sent.map(message => message.message_id)
        : (sent?.message_id ? [sent.message_id] : []);
      publication.publishedAt = new Date().toISOString();
      store.publications[publicationId] = publication;
      store.stats.processed = Number(store.stats.processed || 0) + 1;
      saveStore(store);
      sessions.delete(key(ctx));

      await ctx.reply(
        (session.mode === 'paid' ? '💎 PUBLICACIÓN PREMIUM CREADA' : '✅ PUBLICACIÓN CREADA') +
        '\n\n📢 ' + (channel.title || channel.id) +
        (session.mode === 'paid' ? '\n⭐ Precio: ' + session.priceStars + ' Stars' : '') +
        (messageIds.length > 1 ? '\n🖼️ Elementos del álbum: ' + messageIds.length : '') +
        '\n🆔 ' + publicationId
      );
    } catch (err) {
      delete store.publications[publicationId];
      store.stats.errors = Number(store.stats.errors || 0) + 1;
      saveStore(store);
      console.error('[PUBLISH]', err.description || err.message);
      recordAlert(store, 'publish', err.description || err.message, { channelId: channel.id, publicationId });
      await ctx.reply('❌ No pude publicar: ' + (err.description || err.message));
    }
  }

  bot.command('publish', async ctx => {
    if (!admin(ctx)) return ctx.reply('⛔ Sin permiso.');
    const channels = Object.values(store.channels).filter(channel => channel.enabled);
    if (!channels.length) return ctx.reply('❌ Primero agrega y activa un canal.');
    sessions.set(key(ctx), { step: 'channel' });
    await ctx.reply('📝 CREAR PUBLICACIÓN\n\nSelecciona el canal:', {
      reply_markup: {
        inline_keyboard: channels.map(channel => [{
          text: '📢 ' + (channel.title || channel.id),
          callback_data: 'pub:channel:' + channel.id
        }]).concat([[{ text: '❌ CANCELAR', callback_data: 'pub:cancel' }]])
      }
    });
  });

  bot.action(/^pub:channel:(-?\d+)$/, async ctx => {
    if (!admin(ctx)) return ctx.answerCbQuery('Sin permiso');
    const session = sessions.get(key(ctx)) || {};
    if (!store.channels[ctx.match[1]]) return ctx.answerCbQuery('Canal no encontrado');
    session.channelId = ctx.match[1];
    session.step = 'mode';
    sessions.set(key(ctx), session);
    await ctx.editMessageText('📝 CREAR PUBLICACIÓN\n\n¿Cómo quieres publicarla?', {
      reply_markup: { inline_keyboard: [
        [{ text: '🆓 GRATUITA', callback_data: 'pub:mode:free' }],
        [{ text: '⭐ COBRO EN ESTRELLAS', callback_data: 'pub:mode:paid' }],
        [{ text: '❌ CANCELAR', callback_data: 'pub:cancel' }]
      ]}
    });
    await ctx.answerCbQuery();
  });

  bot.action(/^pub:mode:(free|paid)$/, async ctx => {
    if (!admin(ctx)) return ctx.answerCbQuery('Sin permiso');
    const session = sessions.get(key(ctx)) || {};
    if (!session.channelId) return ctx.answerCbQuery('Sesión expirada');
    session.step = ctx.match[1] === 'paid' ? 'price' : 'content';
    session.mode = ctx.match[1];
    sessions.set(key(ctx), session);
    await ctx.answerCbQuery();
    await ctx.reply(session.mode === 'paid'
      ? '⭐ PRECIO\n\nEnvíame solamente la cantidad de Stars (número entero mayor que 0).\nEjemplo: 50\n\n/cancel para cancelar.'
      : '📝 CONTENIDO\n\nEnvíame texto, foto, video o un álbum.\n\n/cancel para cancelar.');
  });

  bot.on('message', async (ctx, next) => {
    if (!admin(ctx)) return next();
    const session = sessions.get(key(ctx));
    if (!session || session.step !== 'price') return next();
    const raw = String(ctx.message?.text || '').trim();
    const price = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(price) || price <= 0) {
      return ctx.reply('❌ El precio debe ser un número entero de Stars mayor que 0.');
    }
    session.priceStars = price;
    session.step = 'content';
    sessions.set(key(ctx), session);
    await ctx.reply('📝 CONTENIDO PREMIUM\n\nEnvíame el texto, foto, video o álbum que quieres vender.\nEl contenido no se publicará directamente; se entregará al comprador después del pago.\n\n/cancel para cancelar.');
  });

  bot.on('message', async (ctx, next) => {
    if (!admin(ctx)) return next();
    const userKey = key(ctx);
    const session = sessions.get(userKey);
    if (!session || session.step !== 'content') return next();
    if (!ctx.message?.message_id || ctx.message.text?.startsWith('/')) return next();

    const message = ctx.message;
    if (message.media_group_id) {
      let pending = pendingAlbums.get(userKey);
      if (!pending || pending.mediaGroupId !== message.media_group_id) {
        if (pending?.timer) clearTimeout(pending.timer);
        pending = { mediaGroupId: message.media_group_id, messages: [], ctx, session, timer: null };
        pendingAlbums.set(userKey, pending);
      }
      pending.messages.push(message);
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        pendingAlbums.delete(userKey);
        const ordered = pending.messages.sort((a, b) => a.message_id - b.message_id);
        publishContent(pending.ctx, pending.session, ordered).catch(err => console.error('[PUBLISH ALBUM]', err));
      }, 1400);
      return;
    }

    const pending = pendingAlbums.get(userKey);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingAlbums.delete(userKey);
    if (pending?.messages?.length) {
      await publishContent(pending.ctx, pending.session, pending.messages.sort((a, b) => a.message_id - b.message_id));
      // If a separate message arrived while an album was pending, keep the session
      // active only when publication failed; otherwise start a new /publish flow.
      if (!sessions.has(userKey)) return;
    }
    await publishContent(ctx, session, [message]);
  });

  bot.action('pub:cancel', async ctx => {
    if (!admin(ctx)) return ctx.answerCbQuery('Sin permiso');
    const userKey = key(ctx);
    const pending = pendingAlbums.get(userKey);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingAlbums.delete(userKey);
    sessions.delete(userKey);
    await ctx.editMessageText('❌ Publicación cancelada.');
    await ctx.answerCbQuery();
  });

  bot.command('cancel', async ctx => {
    const userKey = key(ctx);
    const pending = pendingAlbums.get(userKey);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingAlbums.delete(userKey);
    sessions.delete(userKey);
  });
}
