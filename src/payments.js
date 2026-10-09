import { recordAlert, saveStore } from './store.js';

function parsePayload(payload) {
  const match = String(payload || '').match(/^paid:([^:]+):([^:]+)$/);
  return match ? { channelId: match[1], publicationId: match[2] } : null;
}

function adminIds() {
  return String(process.env.ADMIN_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
}

function isAdmin(ctx) {
  return adminIds().includes(String(ctx.from?.id));
}

async function notifyAdmins(telegram, message) {
  for (const adminId of adminIds()) {
    try {
      await telegram.sendMessage(adminId, message);
    } catch (err) {
      console.error('[ADMIN NOTICE]', adminId, err.description || err.message);
    }
  }
}

async function deliverPurchase(telegram, store, purchase) {
  const publication = store.publications[purchase.publicationId];
  if (!publication) throw new Error('La publicación asociada ya no existe.');
  if (publication.mode !== 'paid' || String(publication.channelId) !== String(purchase.channelId)) {
    throw new Error('La publicación no coincide con la compra.');
  }

  const messageIds = Array.isArray(publication.sourceMessageIds) && publication.sourceMessageIds.length
    ? publication.sourceMessageIds
    : [publication.sourceMessageId];
  if (messageIds.length > 1) {
    await telegram.copyMessages(purchase.userId, publication.sourceChatId, messageIds);
  } else {
    await telegram.copyMessage(purchase.userId, publication.sourceChatId, messageIds[0]);
  }

  purchase.deliveryStatus = 'delivered';
  purchase.deliveredAt = new Date().toISOString();
  purchase.deliveryError = '';
  saveStore(store);
}

export function registerPayments(bot, store) {
  bot.on('pre_checkout_query', async ctx => {
    const query = ctx.preCheckoutQuery;
    try {
      const data = parsePayload(query.invoice_payload);
      const publication = data && store.publications[data.publicationId];
      const valid = Boolean(
        data &&
        publication &&
        publication.mode === 'paid' &&
        String(publication.channelId) === String(data.channelId) &&
        publication.status === 'published' &&
        query.currency === 'XTR' &&
        Number(query.total_amount) === Number(publication.priceStars)
      );

      if (!valid) {
        return await ctx.answerPreCheckoutQuery(false, 'Esta publicación no está disponible o el precio ya cambió.');
      }
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error('[PRE CHECKOUT]', err.description || err.message);
      recordAlert(store, 'pre-checkout', err.description || err.message);
      try {
        await ctx.answerPreCheckoutQuery(false, 'No pude validar el pedido. Inténtalo de nuevo.');
      } catch (answerError) {
        console.error('[PRE CHECKOUT REPLY]', answerError.description || answerError.message);
      }
    }
  });

  bot.on('successful_payment', async ctx => {
    const payment = ctx.message?.successful_payment;
    if (!payment) return;
    const data = parsePayload(payment.invoice_payload);
    if (!data || payment.currency !== 'XTR') {
      console.error('[PAYMENT] Pago recibido con payload o moneda no válidos.');
      await notifyAdmins(ctx.telegram, '🚨 Pago recibido con datos no válidos. Revisa la transacción en Telegram.');
      return;
    }

    const publication = store.publications[data.publicationId];
    if (!publication || publication.mode !== 'paid' ||
        String(publication.channelId) !== String(data.channelId) ||
        Number(payment.total_amount) !== Number(publication.priceStars)) {
      console.error('[PAYMENT] La compra no coincide con la publicación:', data.publicationId);
      recordAlert(store, 'payment-validation', 'Pago recibido pero la publicación o el precio no coincide.', { publicationId: data.publicationId, userId: ctx.from.id, chargeId: payment.telegram_payment_charge_id });
      await notifyAdmins(ctx.telegram, '🚨 Pago recibido pero la publicación/precio no coincide. Usuario: ' + ctx.from.id + '. Charge ID: ' + payment.telegram_payment_charge_id);
      await ctx.reply('⚠️ Recibí el pago, pero necesito que soporte revise la orden. Usa /paysupport.');
      return;
    }

    const chargeId = payment.telegram_payment_charge_id;
    if (store.purchases[chargeId]) {
      const previous = store.purchases[chargeId];
      if (previous.deliveryStatus !== 'delivered') {
        await ctx.reply('ℹ️ Tu pago ya está registrado. Si el contenido no aparece, usa /paysupport.');
      }
      return;
    }

    const purchase = {
      id: chargeId,
      publicationId: data.publicationId,
      channelId: data.channelId,
      userId: ctx.from.id,
      username: ctx.from.username || '',
      stars: Number(payment.total_amount),
      currency: payment.currency,
      paidAt: new Date().toISOString(),
      deliveryStatus: 'pending',
      deliveryError: ''
    };
    store.purchases[chargeId] = purchase;
    store.stats.payments = Number(store.stats.payments || 0) + 1;
    store.stats.stars = Number(store.stats.stars || 0) + purchase.stars;
    saveStore(store);

    try {
      await deliverPurchase(ctx.telegram, store, purchase);
      await ctx.reply('✅ Pago confirmado.\n\n🔓 Tu contenido premium fue entregado.');
    } catch (err) {
      purchase.deliveryStatus = 'failed';
      purchase.deliveryError = String(err.description || err.message || 'Error de entrega').slice(0, 500);
      saveStore(store);
      console.error('[PAYMENT DELIVERY]', chargeId, purchase.deliveryError);
      recordAlert(store, 'payment-delivery', purchase.deliveryError, { chargeId, userId: purchase.userId, publicationId: purchase.publicationId });
      await ctx.reply('⚠️ Tu pago fue confirmado, pero la entrega automática falló. Usa /paysupport; tu compra quedó registrada.');
      await notifyAdmins(ctx.telegram,
        '🚨 ENTREGA PREMIUM FALLIDA\nUsuario: ' + purchase.userId +
        '\nPublicación: ' + purchase.publicationId +
        '\nStars: ' + purchase.stars +
        '\nCharge ID: ' + chargeId +
        '\nError: ' + purchase.deliveryError +
        '\nUsa /retrydelivery ' + chargeId
      );
    }
  });

  bot.command('paysupport', async ctx => {
    const message = '🆘 SOPORTE DE PAGOS\n\nUsuario: ' + ctx.from.id +
      (ctx.from.username ? '\nUsername: @' + ctx.from.username : '') +
      '\nFecha: ' + new Date().toISOString() +
      '\n\nEl usuario solicita ayuda con una compra de Telegram Stars.';
    await ctx.reply('💎 Solicitud registrada. Si tu compra no se entregó, un administrador revisará el pago.');
    await notifyAdmins(ctx.telegram, message);
  });

  bot.command('retrydelivery', async ctx => {
    if (!isAdmin(ctx)) return;
    const chargeId = String(ctx.message?.text || '').trim().split(/\s+/)[1];
    if (!chargeId) return ctx.reply('Uso: /retrydelivery <telegram_payment_charge_id>');
    const purchase = store.purchases[chargeId];
    if (!purchase) return ctx.reply('❌ No encuentro esa compra.');
    if (purchase.deliveryStatus === 'delivered') return ctx.reply('ℹ️ El contenido ya figura como entregado.');
    try {
      await deliverPurchase(ctx.telegram, store, purchase);
      await ctx.reply('✅ Entrega reintentada para el usuario ' + purchase.userId + '.');
      try {
        await ctx.telegram.sendMessage(purchase.userId, '✅ Se ha completado la entrega pendiente de tu compra.');
      } catch (notifyError) {
        console.error('[DELIVERY NOTICE]', notifyError.description || notifyError.message);
      }
    } catch (err) {
      purchase.deliveryStatus = 'failed';
      purchase.deliveryError = String(err.description || err.message || 'Error de entrega').slice(0, 500);
      saveStore(store);
      await ctx.reply('❌ Sigue fallando la entrega: ' + purchase.deliveryError);
    }
  });

  bot.command('refund', async ctx => {
    if (!isAdmin(ctx)) return;
    const chargeId = String(ctx.message?.text || '').trim().split(/\s+/)[1];
    if (!chargeId) return ctx.reply('Uso: /refund <telegram_payment_charge_id>');
    const purchase = store.purchases[chargeId];
    if (!purchase) return ctx.reply('❌ No encuentro una compra registrada con ese ID.');
    if (purchase.refundedAt) return ctx.reply('ℹ️ Esta compra ya figura como reembolsada.');

    try {
      await ctx.telegram.callApi('refundStarPayment', {
        user_id: purchase.userId,
        telegram_payment_charge_id: chargeId
      });
      purchase.refundedAt = new Date().toISOString();
      purchase.refundStars = Number(purchase.stars || 0);
      store.stats.stars = Math.max(0, Number(store.stats.stars || 0) - purchase.refundStars);
      saveStore(store);
      await ctx.reply('✅ Reembolso procesado para el usuario ' + purchase.userId + '.');
      try {
        await ctx.telegram.sendMessage(purchase.userId, '💳 Se ha procesado el reembolso de tu compra en Telegram Stars.');
      } catch (notifyError) {
        console.error('[REFUND NOTICE]', notifyError.description || notifyError.message);
      }
    } catch (err) {
      recordAlert(store, 'refund', err.description || err.message, { chargeId, userId: purchase.userId });
      await ctx.reply('❌ No se pudo emitir el reembolso: ' + (err.description || err.message));
    }
  });
}
