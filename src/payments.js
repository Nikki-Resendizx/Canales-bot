import { saveStore } from './store.js';

function parsePayload(payload) {
  const m = String(payload || '').match(/^paid:([^:]+):([^:]+)$/);
  return m ? { channelId: m[1], publicationId: m[2] } : null;
}

export function registerPayments(bot, store) {
  bot.on('pre_checkout_query', async ctx => {
    const q = ctx.preCheckoutQuery;
    const data = parsePayload(q.invoice_payload);
    if (!data) return ctx.answerPreCheckoutQuery(false, '❌ Orden no válida.');
    const publication = store.publications[data.publicationId];
    if (!publication || publication.channelId !== data.channelId || publication.status !== 'published') {
      return ctx.answerPreCheckoutQuery(false, '❌ Esta publicación ya no está disponible.');
    }
    if (Number(q.total_amount) !== Number(publication.priceStars)) {
      return ctx.answerPreCheckoutQuery(false, '❌ El precio de esta publicación cambió.');
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  bot.on('successful_payment', async ctx => {
    const payment = ctx.message.successful_payment;
    const data = parsePayload(payment.invoice_payload);
    if (!data) return;

    const publication = store.publications[data.publicationId];
    if (!publication) return;

    const key = payment.telegram_payment_charge_id;
    if (store.purchases[key]) return;

    store.purchases[key] = {
      id: key,
      publicationId: data.publicationId,
      channelId: data.channelId,
      userId: ctx.from.id,
      username: ctx.from.username || '',
      stars: Number(payment.total_amount || publication.priceStars || 0),
      paidAt: new Date().toISOString()
    };
    store.stats.payments += 1;
    store.stats.stars += Number(payment.total_amount || 0);
    saveStore(store);

    try {
      await ctx.telegram.copyMessage(
        ctx.from.id,
        publication.sourceChatId,
        publication.sourceMessageId
      );
      await ctx.reply('✅ Pago confirmado.\n\n🔓 Tu contenido premium fue entregado.');
    } catch (err) {
      console.error('[PAYMENT DELIVERY]', err.description || err.message);
      await ctx.reply('⚠️ Pago confirmado, pero no pude entregar el contenido automáticamente. Contacta con el administrador usando /paysupport.');
    }
  });

  bot.command('paysupport', async ctx => {
    await ctx.reply('💎 SOPORTE DE PAGOS\n\nIndica el problema con tu compra y un administrador revisará la transacción.');
  });

  bot.command('refund', async ctx => {
    const admins = String(process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!admins.includes(String(ctx.from?.id))) return;
    const chargeId = ctx.message.text.split(/\s+/)[1];
    if (!chargeId) return ctx.reply('Uso: /refund <telegram_payment_charge_id>');
    try {
      await ctx.telegram.callApi('refundStarPayment', { user_id: ctx.from.id, telegram_payment_charge_id: chargeId });
      await ctx.reply('✅ Reembolso solicitado.');
    } catch (err) {
      await ctx.reply('❌ No se pudo emitir el reembolso: ' + (err.description || err.message));
    }
  });
}
