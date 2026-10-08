import { ensureChannel, saveStore } from './store.js';

function admin(ctx) {
  return String(process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).includes(String(ctx.from?.id));
}

function id() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function registerPublications(bot, store) {
  const sessions = new Map();
  const key = ctx => String(ctx.from.id);

  bot.command('publish', async ctx => {
    if (!admin(ctx)) return;
    const channels = Object.values(store.channels).filter(c => c.enabled);
    if (!channels.length) return ctx.reply('❌ Primero agrega y activa un canal.');
    sessions.set(key(ctx), { step: 'channel' });
    await ctx.reply('📝 CREAR PUBLICACIÓN\n\nSelecciona el canal:', {
      reply_markup: { inline_keyboard: channels.map(c => [{ text: '📢 ' + (c.title || c.id), callback_data: 'pub:channel:' + c.id }]).concat([[{ text: '❌ CANCELAR', callback_data: 'pub:cancel' }]]) }
    });
  });

  bot.action(/^pub:channel:(-?\d+)$/, async ctx => {
    if (!admin(ctx)) return ctx.answerCbQuery('Sin permiso');
    const s = sessions.get(key(ctx)) || {};
    s.channelId = ctx.match[1];
    s.step = 'mode';
    sessions.set(key(ctx), s);
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
    const s = sessions.get(key(ctx)) || {};
    if (!s.channelId) return ctx.answerCbQuery('Sesión expirada');
    s.step = ctx.match[1] === 'paid' ? 'price' : 'content';
    s.mode = ctx.match[1];
    sessions.set(key(ctx), s);
    await ctx.answerCbQuery();
    await ctx.reply(s.mode === 'paid'
      ? '⭐ PRECIO\n\nEnvíame solamente la cantidad de Stars.\nEjemplo: 50\n\n/cancel para cancelar.'
      : '📝 CONTENIDO\n\nEnvíame el mensaje, foto o video que quieres publicar.\n\n/cancel para cancelar.');
  });

  bot.on('message', async (ctx, next) => {
    if (!admin(ctx)) return next();
    const s = sessions.get(key(ctx));
    if (!s || s.step !== 'price') return next();
    const price = Number(ctx.message.text);
    if (!Number.isInteger(price) || price <= 0) return ctx.reply('❌ El precio debe ser un número entero de Stars mayor que 0.');
    s.priceStars = price;
    s.step = 'content';
    sessions.set(key(ctx), s);
    await ctx.reply('📝 CONTENIDO PREMIUM\n\nEnvíame ahora el mensaje, foto o video que quieres vender.\n\nEl mensaje recibido quedará como contenido privado y no se publicará directamente.\n\n/cancel para cancelar.');
  });

  bot.on('message', async (ctx, next) => {
    if (!admin(ctx)) return next();
    const s = sessions.get(key(ctx));
    if (!s || s.step !== 'content') return next();
    if (!ctx.message.message_id) return;

    const c = ensureChannel(store, s.channelId);
    const publicationId = id();
    const publication = {
      id: publicationId,
      channelId: c.id,
      channelTitle: c.title || '',
      mode: s.mode,
      priceStars: s.priceStars || 0,
      sourceChatId: ctx.chat.id,
      sourceMessageId: ctx.message.message_id,
      status: 'draft',
      createdAt: new Date().toISOString()
    };

    try {
      // Save the order before the invoice becomes visible to buyers.
      publication.status = 'published';
      store.publications[publicationId] = publication;
      saveStore(store);

      let sent;
      if (s.mode === 'paid') {
        sent = await ctx.telegram.callApi('sendInvoice', {
          chat_id: c.id,
          title: 'Contenido Premium',
          description: 'Desbloquea esta publicación con Telegram Stars.',
          payload: 'paid:' + c.id + ':' + publicationId,
          currency: 'XTR',
          prices: [{ label: 'Contenido Premium', amount: s.priceStars }],
          start_parameter: 'premium_' + publicationId
        });
      } else {
        sent = await ctx.telegram.copyMessage(c.id, ctx.chat.id, ctx.message.message_id);
      }

      publication.status = 'published';
      publication.channelMessageId = sent?.message_id || null;
      publication.publishedAt = new Date().toISOString();
      store.publications[publicationId] = publication;
      store.stats.processed += 1;
      saveStore(store);
      sessions.delete(key(ctx));

      await ctx.reply(
        (s.mode === 'paid' ? '💎 PUBLICACIÓN PREMIUM CREADA' : '✅ PUBLICACIÓN CREADA') +
        '\n\n📢 ' + (c.title || c.id) +
        (s.mode === 'paid' ? '\n⭐ Precio: ' + s.priceStars : '') +
        '\n🆔 ' + publicationId
      );
    } catch (err) {
      delete store.publications[publicationId];
      store.stats.errors += 1;
      saveStore(store);
      console.error('[PUBLISH]', err.description || err.message);
      await ctx.reply('❌ No pude publicar: ' + (err.description || err.message));
    }
  });

  bot.action('pub:cancel', async ctx => {
    if (!admin(ctx)) return ctx.answerCbQuery('Sin permiso');
    sessions.delete(key(ctx));
    await ctx.editMessageText('❌ Publicación cancelada.');
    await ctx.answerCbQuery();
  });

  bot.command('cancel', async ctx => {
    sessions.delete(key(ctx));
  });
}
