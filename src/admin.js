import { ensureChannel } from './store.js';

function allowed(ctx) {
  const ids = String(process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  return ids.includes(String(ctx.from?.id));
}

const menu = {
  reply_markup: { inline_keyboard: [
    [{ text: '📢 CANALES', callback_data: 'admin:channels' }],
    [{ text: '📝 PLANTILLAS', callback_data: 'admin:templates' }],
    [{ text: '#️⃣ HASHTAGS', callback_data: 'admin:hashtags' }],
    [{ text: '🔘 BOTONES', callback_data: 'admin:buttons' }],
    [{ text: '⚙️ CONFIGURACIÓN', callback_data: 'admin:settings' }]
  ]}
};

function channelMenu(c) {
  return {
    reply_markup: { inline_keyboard: [
      [{ text: '📝 PLANTILLAS', callback_data: 'tpl:' + c.id }],
      [{ text: '#️⃣ HASHTAGS', callback_data: 'hash:' + c.id }],
      [{ text: '🔘 BOTONES', callback_data: 'btn:' + c.id }],
      [{ text: '🔙 CANALES', callback_data: 'admin:channels' }]
    ]}
  };
}

async function showChannels(ctx, store, edit = false) {
  const rows = Object.values(store.channels).map(c => [{
    text: (c.enabled ? '🟢 ' : '🔴 ') + (c.title || c.id),
    callback_data: 'channel:' + c.id
  }]);
  rows.push([{ text: '➕ AGREGAR CANAL', callback_data: 'admin:addchannel' }]);
  rows.push([{ text: '🔙 VOLVER', callback_data: 'admin:home' }]);

  const text = '📢 MIS CANALES\n\n' +
    (Object.keys(store.channels).length ? 'Selecciona un canal:' : 'No hay canales configurados.');

  if (edit) {
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } });
  } else {
    await ctx.reply(text, { reply_markup: { inline_keyboard: rows } });
  }
}

export function registerAdmin(bot, store) {
  const waitingForChannel = new Set();

  bot.command('admin', async ctx => {
    if (!allowed(ctx)) return ctx.reply('⛔ Sin permiso.');
    return ctx.reply('⚙️ PANEL DE ADMINISTRACIÓN\n\nSelecciona una sección:', menu);
  });

  bot.action('admin:channels', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await showChannels(ctx, store, true);
    await ctx.answerCbQuery();
  });

  bot.action('admin:home', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await ctx.editMessageText('⚙️ PANEL DE ADMINISTRACIÓN\n\nSelecciona una sección:', menu);
    await ctx.answerCbQuery();
  });

  bot.action('admin:addchannel', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    waitingForChannel.add(String(ctx.from.id));
    await ctx.answerCbQuery();
    await ctx.reply(
      '➕ AGREGAR CANAL\n\n' +
      'Agrega el bot como administrador del canal y envíame su ID.\n' +
      'Ejemplo: -1001234567890\n\n' +
      'Puedes cancelar con /cancel.'
    );
  });

  bot.command('cancel', async ctx => {
    waitingForChannel.delete(String(ctx.from.id));
    if (allowed(ctx)) await ctx.reply('❌ Operación cancelada.');
  });

  bot.command('addchannel', async ctx => {
    if (!allowed(ctx)) return;
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Uso: /addchannel -1001234567890');
    await addChannelFromId(ctx, store, id, waitingForChannel);
  });

  async function addChannelFromId(ctx, store, rawId, waitingSet) {
    const id = String(rawId).trim();

    if (!/^-100\d{5,}$/.test(id)) {
      return ctx.reply('❌ ID de canal no válido. Debe tener este formato:\n-1001234567890');
    }

    try {
      const chat = await ctx.telegram.getChat(id);

      if (!['channel'].includes(chat.type)) {
        return ctx.reply('❌ Ese ID no corresponde a un canal de Telegram.');
      }

      const existed = Boolean(store.channels[id]);
      const c = ensureChannel(store, id, chat.title || '');

      waitingSet.delete(String(ctx.from.id));

      await ctx.reply(
        (existed ? 'ℹ️ El canal ya estaba registrado.' : '✅ Canal agregado correctamente.') +
        '\n\n📢 ' + (c.title || 'Canal') +
        '\n🆔 ' + c.id +
        '\n\nYa puedes configurarlo desde /admin → CANALES.',
        { reply_markup: { inline_keyboard: [[{ text: '📢 ABRIR CANALES', callback_data: 'admin:channels' }]] } }
      );
    } catch (err) {
      console.error('[ADD CHANNEL]', err.description || err.message);
      await ctx.reply(
        '❌ No pude acceder a ese canal.\n\n' +
        'Verifica que:\n' +
        '• El ID sea correcto.\n' +
        '• El bot esté agregado al canal.\n' +
        '• El bot sea administrador del canal.'
      );
    }
  }

  bot.on('text', async ctx => {
    if (!allowed(ctx)) return;
    const userId = String(ctx.from.id);
    if (!waitingForChannel.has(userId)) return;

    const id = String(ctx.message.text || '').trim();
    await addChannelFromId(ctx, store, id, waitingForChannel);
  });

  bot.action(/^channel:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText(
      '📢 ' + (c.title || 'Canal') + '\n\nID: ' + c.id + '\nEstado: ' + (c.enabled ? '🟢 Activo' : '🔴 Inactivo'),
      channelMenu(c)
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^tpl:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText(
      '📝 PLANTILLAS — ' + (c.title || c.id) + '\n\nTipos: text, photo, video, album, link, forwarded\n\nUsa /settemplate TIPO TEXTO\nVariable: {contenido}',
      { reply_markup: { inline_keyboard: [[{ text: '🔙 CANAL', callback_data: 'channel:' + c.id }]] } }
    );
    await ctx.answerCbQuery();
  });

  bot.command('settemplate', async ctx => {
    if (!allowed(ctx)) return;
    const parts = ctx.message.text.split(/\s+/);
    const type = parts[1];
    const template = parts.slice(2).join(' ').trim();
    if (!['text','photo','video','album','link','forwarded'].includes(type) || !template)
      return ctx.reply('Uso: /settemplate photo Texto de plantilla');
    return ctx.reply('⚠️ Selecciona primero el canal desde /admin. El editor visual por canal está en la siguiente fase.');
  });

  bot.action(/^hash:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText(' #️⃣ HASHTAGS — ' + (c.title || c.id) + '\n\n' + (c.hashtags.join(' ') || 'Sin hashtags.') + '\n\nUsa /sethashtags después de seleccionar canal.', { reply_markup: { inline_keyboard: [[{ text: '🔙 CANAL', callback_data: 'channel:' + c.id }]] }});
    await ctx.answerCbQuery();
  });

  bot.action(/^btn:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText('🔘 BOTONES — ' + (c.title || c.id) + '\n\nEditor visual pendiente de V2.', { reply_markup: { inline_keyboard: [[{ text: '🔙 CANAL', callback_data: 'channel:' + c.id }]] }});
    await ctx.answerCbQuery();
  });

  bot.action('admin:templates', ctx => ctx.answerCbQuery('Las plantillas se administran por canal.'));
  bot.action('admin:hashtags', ctx => ctx.answerCbQuery('Los hashtags se administran por canal.'));
  bot.action('admin:buttons', ctx => ctx.answerCbQuery('Los botones se administran por canal.'));
  bot.action('admin:settings', ctx => ctx.answerCbQuery('Configuración global próximamente.'));
}
