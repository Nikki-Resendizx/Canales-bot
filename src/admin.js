import { ensureChannel, saveStore } from './store.js';

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

const TYPES = [
  ['text', '💬 TEXTO'], ['photo', '🖼️ FOTO'], ['video', '🎬 VIDEO'],
  ['album', '🖼️ ÁLBUM'], ['link', '🔗 ENLACE'], ['forwarded', '↪️ REENVIADO']
];

const FORMATS = [
  ['AUTO', '🤖 AUTOMÁTICO'],
  ['HTML', 'HTML'],
  ['Markdown', 'Markdown'],
  ['MarkdownV2', 'MarkdownV2'],
  ['rich_message', 'rich_message'],
  ['Telegram', 'Telegram'],
  ['OFF', 'OFF']
];

function addChannelKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{
        text: '📢 SELECCIONAR CANAL',
        style: 'primary',
        request_chat: {
          request_id: 1001,
          chat_is_channel: true,
          user_administrator_rights: {
            can_manage_chat: true
          },
          bot_administrator_rights: {
            can_manage_chat: true,
            can_post_messages: true,
            can_edit_messages: true,
            can_delete_messages: true
          },
          request_title: true,
          request_username: true,
          request_photo: true
        }
      }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

async function addChannelFromChat(ctx, store, chatId, shared = {}) {
  const id = String(chatId);
  try {
    const chat = await ctx.telegram.getChat(id);
    if (chat.type !== 'channel') return ctx.reply('❌ El chat seleccionado no es un canal.', removeKeyboard());

    const existed = Boolean(store.channels[id]);
    const c = ensureChannel(store, id, chat.title || shared.title || '');
    clearSession(ctx);

    return ctx.reply(
      (existed ? 'ℹ️ El canal ya estaba registrado.' : '✅ Canal agregado automáticamente.') +
      '\n\n📢 ' + (c.title || chat.title || 'Canal') +
      '\n🆔 ' + c.id +
      (chat.username ? '\n🔗 @' + chat.username : '') +
      '\n🟢 Listo para procesar publicaciones.',
      {
        ...removeKeyboard(),
        reply_markup: {
          inline_keyboard: [[{ text: '📢 ABRIR CANALES', callback_data: 'admin:channels' }]]
        }
      }
    );
  } catch (err) {
    console.error('[ADD CHANNEL SHARED]', err.description || err.message);
    return ctx.reply('❌ Telegram no me permitió acceder al canal seleccionado.\n\nAsegúrate de que el bot tenga permisos de administrador para publicar y editar mensajes.', removeKeyboard());
  }
}

const sessions = new Map();
const key = ctx => String(ctx.from.id);
const setSession = (ctx, data) => sessions.set(key(ctx), data);
const getSession = ctx => sessions.get(key(ctx));
const clearSession = ctx => sessions.delete(key(ctx));

function channelMenu(c) {
  return { reply_markup: { inline_keyboard: [
    [{ text: '📝 PLANTILLAS', callback_data: 'tpl:' + c.id }],
    [{ text: '#️⃣ HASHTAGS', callback_data: 'hash:' + c.id }],
    [{ text: '🔘 BOTONES', callback_data: 'btn:' + c.id }],
    [{ text: c.enabled ? '🔴 DESACTIVAR' : '🟢 ACTIVAR', callback_data: 'toggle:' + c.id }],
    [{ text: '🗑️ ELIMINAR', callback_data: 'delete:' + c.id }],
    [{ text: '🔙 CANALES', callback_data: 'admin:channels' }]
  ]}};
}

async function showChannels(ctx, store, edit = false) {
  const rows = Object.values(store.channels).map(c => [{
    text: (c.enabled ? '🟢 ' : '🔴 ') + (c.title || c.id),
    callback_data: 'channel:' + c.id
  }]);
  rows.push([{ text: '➕ AGREGAR CANAL', callback_data: 'admin:addchannel' }]);
  rows.push([{ text: '🔙 VOLVER', callback_data: 'admin:home' }]);
  const text = '📢 MIS CANALES\n\n' + (Object.keys(store.channels).length ? 'Selecciona un canal:' : 'No hay canales configurados.');
  if (edit) await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } });
  else await ctx.reply(text, { reply_markup: { inline_keyboard: rows } });
}

function templateKeyboard(c) {
  return { reply_markup: { inline_keyboard: [
    ...TYPES.map(([type, label]) => [{ text: label, callback_data: 'template:' + c.id + ':' + type }]),
    [{ text: '📝 FORMATO', callback_data: 'format:' + c.id }],
    [{ text: '🔙 CANAL', callback_data: 'channel:' + c.id }]
  ]}};
}

function buttonKeyboard(c) {
  const rows = c.buttons.map((b, i) => [{
    text: (b.style ? b.style.toUpperCase() + ' ' : '') + (b.icon_custom_emoji_id ? '✨ ' : '') + b.text,
    callback_data: 'button:view:' + c.id + ':' + i
  }]);
  rows.push([{ text: '➕ AÑADIR BOTÓN', callback_data: 'button:add:' + c.id }]);
  rows.push([{ text: '🧹 BORRAR TODOS', callback_data: 'button:clear:' + c.id }]);
  rows.push([{ text: '🔙 CANAL', callback_data: 'channel:' + c.id }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function addChannelFromId(ctx, store, rawId) {
  const id = String(rawId).trim();
  if (!/^-100\d{5,}$/.test(id)) return ctx.reply('❌ ID de canal no válido.\n\nEjemplo: -1001234567890');
  try {
    const chat = await ctx.telegram.getChat(id);
    if (chat.type !== 'channel') return ctx.reply('❌ Ese ID no corresponde a un canal.');
    const existed = Boolean(store.channels[id]);
    const c = ensureChannel(store, id, chat.title || '');
    clearSession(ctx);
    return ctx.reply((existed ? 'ℹ️ El canal ya estaba registrado.' : '✅ Canal agregado correctamente.') + '\n\n📢 ' + (c.title || 'Canal') + '\n🆔 ' + c.id, {
      reply_markup: { inline_keyboard: [[{ text: '📢 ABRIR CANALES', callback_data: 'admin:channels' }]] }
    });
  } catch (err) {
    console.error('[ADD CHANNEL]', err.description || err.message);
    return ctx.reply('❌ No pude acceder al canal.\n\nComprueba el ID y que el bot sea administrador del canal.');
  }
}

export function registerAdmin(bot, store) {
  bot.command('admin', async ctx => {
    if (!allowed(ctx)) return ctx.reply('⛔ Sin permiso.');
    clearSession(ctx);
    return ctx.reply('⚙️ PANEL DE ADMINISTRACIÓN\n\nSelecciona una sección:', menu);
  });

  bot.command('cancel', async ctx => {
    clearSession(ctx);
    if (allowed(ctx)) await ctx.reply('❌ Operación cancelada.');
  });

  bot.action('admin:home', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    clearSession(ctx);
    await ctx.editMessageText('⚙️ PANEL DE ADMINISTRACIÓN\n\nSelecciona una sección:', menu);
    await ctx.answerCbQuery();
  });

  bot.action('admin:channels', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    clearSession(ctx);
    await showChannels(ctx, store, true);
    await ctx.answerCbQuery();
  });

  bot.action('admin:addchannel', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    setSession(ctx, { action: 'addchannel' });
    await ctx.answerCbQuery();
    await ctx.reply(
      '➕ AGREGAR CANAL\n\nSelecciona directamente el canal desde Telegram. No necesitas copiar el ID.\n\nTelegram solicitará los permisos necesarios y el bot lo registrará automáticamente.',
      addChannelKeyboard()
    );
  });

  bot.on('message', async ctx => {
    if (!allowed(ctx)) return;
    const shared = ctx.message?.chat_shared;
    if (!shared) return;
    if (shared.request_id !== 1001) return;
    await addChannelFromChat(ctx, store, shared.chat_id, shared);
  });

  bot.on('my_chat_member', async ctx => {
    const update = ctx.myChatMember;
    if (!update?.chat || update.chat.type !== 'channel') return;

    const status = update.new_chat_member?.status;
    if (!['administrator', 'member'].includes(status)) return;

    try {
      const chat = await ctx.telegram.getChat(update.chat.id);
      if (chat.type !== 'channel') return;
      const c = ensureChannel(store, chat.id, chat.title || '');
      c.enabled = true;
      saveStore(store);
      console.log('[AUTO CHANNEL]', chat.id, chat.title || '');
    } catch (err) {
      console.error('[AUTO CHANNEL]', err.description || err.message);
    }
  });

  bot.command('addchannel', async ctx => {
    if (!allowed(ctx)) return;
    await addChannelFromId(ctx, store, ctx.message.text.split(/\s+/)[1] || '');
  });

  bot.action(/^channel:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    clearSession(ctx);
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText('📢 ' + (c.title || 'Canal') + '\n\n🆔 ' + c.id + '\nEstado: ' + (c.enabled ? '🟢 Activo' : '🔴 Inactivo'), channelMenu(c));
    await ctx.answerCbQuery();
  });

  bot.action(/^toggle:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    c.enabled = !c.enabled; saveStore(store);
    await ctx.editMessageText('📢 ' + (c.title || c.id) + '\n\nEstado: ' + (c.enabled ? '🟢 Activo' : '🔴 Inactivo'), channelMenu(c));
    await ctx.answerCbQuery(c.enabled ? 'Canal activado' : 'Canal desactivado');
  });

  bot.action(/^delete:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const id = ctx.match[1];
    await ctx.editMessageText('⚠️ ¿Eliminar este canal de la configuración?', { reply_markup: { inline_keyboard: [
      [{ text: '🗑️ SÍ, ELIMINAR', callback_data: 'deleteyes:' + id }],
      [{ text: '🔙 CANCELAR', callback_data: 'channel:' + id }]
    ]}});
    await ctx.answerCbQuery();
  });

  bot.action(/^deleteyes:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    delete store.channels[ctx.match[1]]; saveStore(store);
    await showChannels(ctx, store, true);
    await ctx.answerCbQuery('Canal eliminado');
  });

  bot.action(/^tpl:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText('📝 PLANTILLAS — ' + (c.title || c.id) + '\n\nSelecciona el tipo.\n\nVariables:\n{contenido}  {titulo}  {descripcion}\n{enlace}  {hashtags}  {fecha}  {canal}', templateKeyboard(c));
    await ctx.answerCbQuery();
  });

  bot.action(/^template:(-?\d+):(text|photo|video|album|link|forwarded)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const id = ctx.match[1], type = ctx.match[2], c = ensureChannel(store, id);
    setSession(ctx, { action: 'template', channelId: id, type });
    await ctx.answerCbQuery();
    await ctx.reply('📝 EDITAR PLANTILLA — ' + type.toUpperCase() + '\n\nActual:\n' + c.templates[type] + '\n\nEnvíame la nueva plantilla.\n/cancel para cancelar.');
  });

  bot.action(/^format:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    const rows = TYPES.map(([type, label]) => [{
      text: label + ' → ' + (c.formats?.[type] || 'AUTO'),
      callback_data: 'formatpick:' + c.id + ':' + type
    }]);
    rows.push([{ text: '🤖 AUTO: detecta el formato', callback_data: 'formatinfo:' + c.id }]);
    rows.push([{ text: '🔙 PLANTILLAS', callback_data: 'tpl:' + c.id }]);
    await ctx.editMessageText(
      '📝 FORMATO — ' + (c.title || c.id) +
      '\n\nCada tipo puede usar un formato diferente.' +
      '\nAUTO detecta HTML, Markdown, MarkdownV2, rich_message o texto plano.' +
      '\nrich_message permite contenido enriquecido avanzado y mezcla Markdown + HTML compatible.',
      { reply_markup: { inline_keyboard: rows } }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^formatpick:(-?\d+):(text|photo|video|album|link|forwarded)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const id = ctx.match[1], type = ctx.match[2], c = ensureChannel(store, id);
    const rows = FORMATS.map(([value, label]) => [{
      text: (c.formats?.[type] === value ? '✅ ' : '') + label,
      callback_data: 'formatset:' + id + ':' + type + ':' + value
    }]);
    rows.push([{ text: '🔙 FORMATO', callback_data: 'format:' + id }]);
    await ctx.editMessageText(
      '📝 FORMATO — ' + type.toUpperCase() +
      '\n\nActual: ' + (c.formats?.[type] || 'AUTO') +
      '\n\nElige el formato para este tipo de publicación:',
      { reply_markup: { inline_keyboard: rows } }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^formatset:(-?\d+):(text|photo|video|album|link|forwarded):(AUTO|HTML|Markdown|MarkdownV2|rich_message|Telegram|OFF)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const id = ctx.match[1], type = ctx.match[2], format = ctx.match[3], c = ensureChannel(store, id);
    c.formats[type] = format;
    saveStore(store);
    await ctx.answerCbQuery('Formato: ' + format);
    await ctx.editMessageText(
      '📝 FORMATO — ' + type.toUpperCase() +
      '\n\nGuardado: ' + format +
      '\n\nPuedes usar otro formato en los demás tipos.',
      { reply_markup: { inline_keyboard: [[{ text: '🔙 FORMATO', callback_data: 'format:' + id }]] } }
    );
  });

  bot.action(/^formatinfo:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await ctx.answerCbQuery('AUTO detectará el contenido');
  });

  bot.action(/^hash:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    setSession(ctx, { action: 'hashtags', channelId: c.id });
    await ctx.editMessageText('#️⃣ HASHTAGS — ' + (c.title || c.id) + '\n\nActuales:\n' + (c.hashtags.join(' ') || 'Ninguno') + '\n\nEnvíame hashtags separados por espacios.\nEjemplo: #Noticias #Telegram #Canal\n\n/cancel para cancelar.');
    await ctx.answerCbQuery();
  });

  bot.action(/^btn:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText('🔘 BOTONES — ' + (c.title || c.id) + '\n\nEstilos REALES de Telegram: primary (azul), success (verde), danger (rojo).\nTambién puedes usar icon_custom_emoji_id para Emoji Premium.\n\nSelecciona un botón:', buttonKeyboard(c));
    await ctx.answerCbQuery();
  });

  bot.action(/^button:add:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    setSession(ctx, { action: 'button', channelId: ctx.match[1] });
    await ctx.answerCbQuery();
    await ctx.reply('➕ NUEVO BOTÓN\n\nTexto | tipo | destino | estilo | emoji_id | fila\n\ntipo: url o callback\nestilo: primary, success, danger o vacío\nemoji_id: ID del Emoji Premium o vacío\nfila: 0, 1, 2...\n\nEjemplo:\n🔥 VISITAR | url | https://t.me | primary | 5368324170671202286 | 0\n\n/cancel para cancelar.');
  });

  bot.action(/^button:view:(-?\d+):(\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]), index = Number(ctx.match[2]), b = c.buttons[index];
    if (!b) return ctx.answerCbQuery('Botón no encontrado');
    await ctx.editMessageText('🔘 BOTÓN\n\nTexto: ' + b.text + '\nTipo: ' + b.type + '\nDestino: ' + (b.url || b.callback_data || '') + '\nEstilo: ' + (b.style || 'default') + '\nEmoji Premium: ' + (b.icon_custom_emoji_id || 'ninguno') + '\nFila: ' + (b.row ?? 0), { reply_markup: { inline_keyboard: [
      [{ text: '✏️ EDITAR', callback_data: 'button:edit:' + c.id + ':' + index }],
      [{ text: '🗑️ ELIMINAR', callback_data: 'button:delete:' + c.id + ':' + index }],
      [{ text: '🔙 BOTONES', callback_data: 'btn:' + c.id }]
    ]}});
    await ctx.answerCbQuery();
  });

  bot.action(/^button:edit:(-?\d+):(\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    setSession(ctx, { action: 'button', channelId: ctx.match[1], index: Number(ctx.match[2]) });
    await ctx.answerCbQuery();
    await ctx.reply('✏️ EDITAR BOTÓN\n\nTexto | tipo | destino | estilo | emoji_id | fila\n\nEstilos: primary, success, danger o vacío.\n/cancel para cancelar.');
  });

  bot.action(/^button:delete:(-?\d+):(\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]); c.buttons.splice(Number(ctx.match[2]), 1); saveStore(store);
    await ctx.editMessageText('🔘 BOTONES — ' + (c.title || c.id), buttonKeyboard(c)); await ctx.answerCbQuery('Botón eliminado');
  });

  bot.action(/^button:clear:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]); c.buttons = []; saveStore(store);
    await ctx.editMessageText('🔘 BOTONES — ' + (c.title || c.id) + '\n\nNo hay botones configurados.', buttonKeyboard(c)); await ctx.answerCbQuery('Botones eliminados');
  });

  bot.action('admin:templates', ctx => allowed(ctx) ? ctx.answerCbQuery('Entra a CANALES y selecciona un canal.') : ctx.answerCbQuery('Sin permiso'));
  bot.action('admin:hashtags', ctx => allowed(ctx) ? ctx.answerCbQuery('Entra a CANALES y selecciona un canal.') : ctx.answerCbQuery('Sin permiso'));
  bot.action('admin:buttons', ctx => allowed(ctx) ? ctx.answerCbQuery('Entra a CANALES y selecciona un canal.') : ctx.answerCbQuery('Sin permiso'));
  bot.action('admin:settings', ctx => allowed(ctx) ? ctx.answerCbQuery('La configuración se administra por canal.') : ctx.answerCbQuery('Sin permiso'));

  bot.on('text', async ctx => {
    if (!allowed(ctx) || ctx.message.text.startsWith('/')) return;
    const s = getSession(ctx);
    if (!s) return;

    if (s.action === 'addchannel') return addChannelFromId(ctx, store, ctx.message.text);

    if (s.action === 'template') {
      const c = ensureChannel(store, s.channelId);
      c.templates[s.type] = ctx.message.text.trim(); saveStore(store); clearSession(ctx);
      return ctx.reply('✅ Plantilla guardada para ' + s.type + '.');
    }

    if (s.action === 'hashtags') {
      const c = ensureChannel(store, s.channelId);
      c.hashtags = ctx.message.text.split(/\s+/).filter(Boolean).map(tag => tag.startsWith('#') ? tag : '#' + tag.replace(/^#+/, ''));
      saveStore(store); clearSession(ctx);
      return ctx.reply('✅ Hashtags guardados: ' + c.hashtags.join(' '));
    }

    if (s.action === 'button') {
      const parts = ctx.message.text.split('|').map(x => x.trim());
      if (parts.length < 6) return ctx.reply('❌ Formato: Texto | tipo | destino | estilo | emoji_id | fila');
      const [text, type, destination, style, emojiId, rowRaw] = parts;
      if (!text || !['url', 'callback'].includes(type)) return ctx.reply('❌ Tipo debe ser url o callback.');
      if (type === 'url' && !/^https?:\/\//i.test(destination)) return ctx.reply('❌ La URL debe comenzar con http:// o https://');
      if (type === 'callback' && Buffer.byteLength(destination, 'utf8') > 64) return ctx.reply('❌ callback_data supera 64 bytes.');
      if (style && !['primary', 'success', 'danger'].includes(style.toLowerCase())) return ctx.reply('❌ Estilo: primary, success o danger.');
      const row = Number.isInteger(Number(rowRaw)) && Number(rowRaw) >= 0 ? Number(rowRaw) : 0;
      const button = { text, type, ...(type === 'url' ? { url: destination } : { callback_data: destination }), ...(style ? { style: style.toLowerCase() } : {}), ...(emojiId ? { icon_custom_emoji_id: emojiId } : {}), row };
      const c = ensureChannel(store, s.channelId);
      if (s.index === undefined) c.buttons.push(button); else c.buttons[s.index] = button;
      saveStore(store); clearSession(ctx);
      return ctx.reply('✅ Botón guardado con Style de Telegram' + (emojiId ? ' + Emoji Premium.' : '.'));
    }
  });
}
