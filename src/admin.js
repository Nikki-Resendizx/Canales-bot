import { ensureChannel, recordAlert, saveStore } from './store.js';

let activeStore = null;

function configuredAdminIds() {
  return String(process.env.ADMIN_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
}

// OWNER_ID define al propietario único. Para instalaciones existentes,
// si no está definido se toma el primer ID de ADMIN_IDS.
function rootAdminIds() {
  const ownerId = String(process.env.OWNER_ID || configuredAdminIds()[0] || '').trim();
  return /^\d+$/.test(ownerId) ? [ownerId] : [];
}

function rootAllowed(ctx) {
  return rootAdminIds().includes(String(ctx.from?.id));
}

function allowed(ctx) {
  const ids = [...configuredAdminIds(), ...rootAdminIds(), ...(Array.isArray(activeStore?.global?.adminIds) ? activeStore.global.adminIds.map(String) : [])];
  return ids.includes(String(ctx.from?.id));
}

const channelAdminCache = new Map();
const CHANNEL_ACCESS_TTL = 30_000;

async function userIsChannelAdmin(ctx, channelId) {
  const userId = String(ctx.from?.id || '');
  const id = String(channelId);
  if (!userId || !storeChannelExists(id)) return false;
  const cacheKey = userId + ':' + id;
  const cached = channelAdminCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;
  let isAdmin = false;
  try {
    const member = await ctx.telegram.getChatMember(id, Number(userId));
    isAdmin = ['creator', 'administrator'].includes(member?.status);
  } catch (err) {
    console.warn('[CHANNEL ACCESS]', userId, id, err.description || err.message);
  }
  channelAdminCache.set(cacheKey, { allowed: isAdmin, expiresAt: Date.now() + CHANNEL_ACCESS_TTL });
  return isAdmin;
}

function storeChannelExists(id) {
  return Boolean(activeStore?.channels?.[String(id)]);
}

async function visibleChannels(ctx, store) {
  const channels = Object.values(store.channels || {});
  const results = await Promise.all(channels.map(async channel =>
    (await userIsChannelAdmin(ctx, channel.id)) ? channel : null
  ));
  return results.filter(Boolean);
}

const menuRows = [
    [
      { text: '📢 CANALES', callback_data: 'admin:channels' },
      { text: '📝 PLANTILLAS', callback_data: 'admin:templates' },
      { text: '#️⃣ HASHTAGS', callback_data: 'admin:hashtags' }
    ],
    [
      { text: '🔘 BOTONES', callback_data: 'admin:buttons' },
      { text: '📝 CREAR PUBLICACIÓN', callback_data: 'admin:publish' },
      { text: '⭐ PREMIUM / ESTRELLAS', callback_data: 'admin:premium' }
    ],
    [
      { text: '📊 ESTADÍSTICAS', callback_data: 'admin:stats' },
      { text: '🧩 REGLAS AUTOMÁTICAS', callback_data: 'admin:rules' },
      { text: '🧪 MODO PRUEBA', callback_data: 'admin:test' }
    ],
    [
      { text: '👥 ADMINISTRADORES', callback_data: 'admin:admins' },
      { text: '📋 HISTORIAL', callback_data: 'admin:history' },
      { text: '🚨 ALERTAS', callback_data: 'admin:alerts' }
    ],
    [
      { text: '💾 BACKUP / RESTAURAR', callback_data: 'admin:backup' },
      { text: '🔀 DISTRIBUCIÓN', callback_data: 'admin:distribution' },
      { text: '⚙️ CONFIGURACIÓN', callback_data: 'admin:settings' }
    ]
  ];

function adminMenu(ctx) {
  const rows = menuRows.map(row => row.slice());
  if (!rootAllowed(ctx)) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const filtered = rows[i].filter(button => button.callback_data !== 'admin:admins');
      if (filtered.length) rows[i] = filtered;
      else rows.splice(i, 1);
    }
  }
  return { reply_markup: { inline_keyboard: rows } };
}

const TYPES = [
  ['text', '💬 TEXTO'], ['photo', '🖼️ FOTO'], ['video', '🎬 VIDEO'],
  ['album', '🖼️ ÁLBUM'], ['link', '🔗 ENLACE'], ['forwarded', '↪️ REENVIADO']
];

const FORMATS = [
  ['AUTO', '🤖 AUTOMÁTICO'],
  ['HTML', 'HTML'],
  ['Markdown', 'Markdown'],
  ['MarkdownV2', 'MarkdownV2'],
  ['rich_message', '✨ RICH MESSAGE'],
  ['Telegram', 'Telegram'],
  ['OFF', 'OFF']
];

function addChannelKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{
        text: '📢 SELECCIONAR CANAL',
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

async function verifyBotChannelPermissions(ctx, chatId) {
  const me = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chatId, me.id);
  return member?.status === 'administrator' &&
    member.can_post_messages !== false &&
    member.can_edit_messages !== false;
}

async function addChannelFromChat(ctx, store, chatId, shared = {}) {
  const id = String(chatId);
  try {
    const chat = await ctx.telegram.getChat(id);
    if (chat.type !== 'channel') return ctx.reply('❌ El chat seleccionado no es un canal.', removeKeyboard());
    if (!await verifyBotChannelPermissions(ctx, id)) {
      return ctx.reply('❌ El bot debe ser administrador del canal con permisos para publicar y editar mensajes.', removeKeyboard());
    }

    const existed = Boolean(store.channels[id]);
    const c = ensureChannel(store, id, chat.title || shared.title || '');
    clearSession(ctx);

    await ctx.reply(
      (existed ? 'ℹ️ El canal ya estaba registrado.' : '✅ Canal agregado automáticamente.') +
      '\n\n📢 ' + (c.title || chat.title || 'Canal') +
      '\n🆔 ' + c.id +
      (chat.username ? '\n🔗 @' + chat.username : '') +
      '\n🟢 Listo para procesar publicaciones.',
      removeKeyboard()
    );
    return ctx.reply('¿Quieres configurar otro canal o editar sus opciones?', {
      reply_markup: { inline_keyboard: [[{ text: '📢 ABRIR CANALES', callback_data: 'admin:channels' }]] }
    });
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
    [{ text: c.testMode ? '🧪 PRUEBA: ACTIVADA' : '🧪 ACTIVAR MODO PRUEBA', callback_data: 'testmode:' + c.id }],
    [{ text: '🗑️ ELIMINAR', callback_data: 'delete:' + c.id }],
    [{ text: '🔙 CANALES', callback_data: 'admin:channels' }]
  ]}};
}

async function showChannels(ctx, store, edit = false) {
  const channels = await visibleChannels(ctx, store);
  const rows = channels.map(c => [{
    text: (c.enabled ? '🟢 ' : '🔴 ') + (c.title || c.id),
    callback_data: 'channel:' + c.id
  }]);
  rows.push([{ text: '➕ AGREGAR CANAL', callback_data: 'admin:addchannel' }]);
  rows.push([{ text: '🔙 VOLVER', callback_data: 'admin:home' }]);
  const text = '📢 MIS CANALES\n\n' + (channels.length ? 'Selecciona un canal:' : 'No tienes canales conectados donde seas administrador.');
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
    if (!await verifyBotChannelPermissions(ctx, id)) {
      return ctx.reply('❌ El bot debe ser administrador del canal con permisos para publicar y editar mensajes.');
    }
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
  activeStore = store;
  if (!Array.isArray(store.global.adminIds)) store.global.adminIds = [];

  // Enforce channel-level Telegram administrator status on every channel callback,
  // not just when rendering the channel list.
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !allowed(ctx)) return next();
    const match = data.match(/-100\d{5,}/);
    if (!match) return next();
    const channelId = match[0];
    if (!store.channels[channelId] || !(await userIsChannelAdmin(ctx, channelId))) {
      try { await ctx.answerCbQuery('⛔ Solo puedes administrar canales donde eres administrador.'); } catch {}
      return;
    }
    return next();
  });

  bot.command('admin', async ctx => {
    if (!allowed(ctx)) return ctx.reply('⛔ Sin permiso.');
    clearSession(ctx);
    return ctx.reply('⚙️ PANEL DE ADMINISTRACIÓN\n\nSelecciona una sección:', adminMenu(ctx));
  });

  bot.command('cancel', async (ctx, next) => {
    clearSession(ctx);
    if (allowed(ctx)) await ctx.reply('❌ Operación cancelada.');
    return next();
  });

  bot.action('admin:home', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    clearSession(ctx);
    await ctx.editMessageText('⚙️ PANEL DE ADMINISTRACIÓN\n\nSelecciona una sección:', adminMenu(ctx));
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

  bot.on('message', async (ctx, next) => {
    if (!allowed(ctx)) return next();
    const shared = ctx.message?.chat_shared;
    if (!shared || shared.request_id !== 1001) return next();
    await addChannelFromChat(ctx, store, shared.chat_id, shared);
  });

  bot.on('my_chat_member', async ctx => {
    const update = ctx.myChatMember;
    if (!update?.chat || update.chat.type !== 'channel') return;

    const status = update.new_chat_member?.status;
    try {
      if (['left', 'kicked'].includes(status)) {
        const existing = store.channels[String(update.chat.id)];
        if (existing) {
          existing.enabled = false;
          saveStore(store);
          recordAlert(store, 'channel-permission', 'El bot salió o perdió acceso al canal.', { channelId: String(update.chat.id), status });
        }
        return;
      }

      const chat = await ctx.telegram.getChat(update.chat.id);
      if (chat.type !== 'channel') return;
      const c = ensureChannel(store, chat.id, chat.title || '');
      const member = update.new_chat_member;
      const canPost = status === 'administrator' && member?.can_post_messages !== false && member?.can_edit_messages !== false;
      c.enabled = canPost;
      saveStore(store);
      if (!canPost) {
        recordAlert(store, 'channel-permission', 'El bot fue añadido al canal sin permisos suficientes para publicar.', { channelId: String(chat.id), status });
        console.warn('[AUTO CHANNEL] Permisos insuficientes:', chat.id);
        return;
      }
      console.log('[AUTO CHANNEL]', chat.id, chat.title || '');
    } catch (err) {
      console.error('[AUTO CHANNEL]', err.description || err.message);
      recordAlert(store, 'channel-registration', err.description || err.message, { channelId: String(update.chat.id) });
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
      '\nAUTO detecta Rich Message, HTML, Markdown, MarkdownV2 o texto plano.' +
      '',
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
    if (format === 'rich_message' && ['photo', 'video', 'album'].includes(type)) {
      return ctx.answerCbQuery('Rich Message solo se puede aplicar a mensajes de texto.');
    }
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

  bot.action('admin:publish', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await ctx.answerCbQuery();
    await ctx.reply('📝 CREAR PUBLICACIÓN\n\nUsa /publish para crear una publicación gratuita o una publicación con cobro en ⭐ Telegram Stars.');
  });

  bot.action('admin:premium', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const total = Object.values(store.publications || {}).filter(p => p.mode === 'paid').length;
    await ctx.answerCbQuery();
    await ctx.editMessageText('⭐ PREMIUM / ESTRELLAS\n\nPublicaciones premium: ' + total + '\n⭐ Stars netas registradas: ' + Number(store.stats?.stars || 0) + '\n💳 Compras: ' + Number(store.stats?.payments || 0) + '\n\nPara crear una venta usa /publish.', { reply_markup: { inline_keyboard: [[{ text: '📝 CREAR PUBLICACIÓN', callback_data: 'admin:publish' }], [{ text: '🔙 PANEL', callback_data: 'admin:home' }]] } });
  });

  bot.action('admin:stats', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const channels = (await visibleChannels(ctx, store)).length;
    await ctx.answerCbQuery();
    await ctx.editMessageText('📊 ESTADÍSTICAS\n\n📢 Tus canales: ' + channels + '\n📝 Publicaciones procesadas: ' + Number(store.stats?.processed || 0) + '\n🔀 Mensajes distribuidos: ' + Number(store.stats?.distributed || 0) + '\n⚠️ Errores de distribución: ' + Number(store.stats?.distributionErrors || 0) + '\n💳 Compras: ' + Number(store.stats?.payments || 0) + '\n⭐ Stars: ' + Number(store.stats?.stars || 0) + '\n❌ Errores: ' + Number(store.stats?.errors || 0), { reply_markup: { inline_keyboard: [[{ text: '🔙 PANEL', callback_data: 'admin:home' }]] } });
  });

  bot.action('admin:rules', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const channels = await visibleChannels(ctx, store);
    const rows = channels.map(c => [{ text: '🧩 ' + (c.title || c.id), callback_data: 'ruleschannel:' + c.id }]);
    rows.push([{ text: '📢 CANALES', callback_data: 'admin:channels' }]);
    rows.push([{ text: '🔙 PANEL', callback_data: 'admin:home' }]);
    await ctx.editMessageText('🧩 REGLAS AUTOMÁTICAS\n\nSelecciona un canal para activar o desactivar sus reglas:', { reply_markup: { inline_keyboard: rows } });
    await ctx.answerCbQuery();
  });

  bot.action(/^ruleschannel:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    await ctx.editMessageText('🧩 REGLAS — ' + (c.title || c.id) +
      '\n\nEstado: ' + (c.enabled ? '🟢 Activo' : '🔴 Inactivo') +
      '\nNormalizar espacios: ' + (c.normalize ? '🟢 Sí' : '🔴 No') +
      '\nModo prueba: ' + (c.testMode ? '🟢 Sí' : '🔴 No') +
      '\nHashtags: ' + (c.hashtags.join(' ') || 'ninguno') +
      '\nBotones: ' + c.buttons.length,
      { reply_markup: { inline_keyboard: [
        [{ text: c.normalize ? '🔴 DESACTIVAR NORMALIZACIÓN' : '🟢 ACTIVAR NORMALIZACIÓN', callback_data: 'normalizetoggle:' + c.id }],
        [{ text: c.testMode ? '🧪 DESACTIVAR PRUEBA' : '🧪 ACTIVAR PRUEBA', callback_data: 'testmode:' + c.id }],
        [{ text: c.enabled ? '🔴 DESACTIVAR CANAL' : '🟢 ACTIVAR CANAL', callback_data: 'toggle:' + c.id }],
        [{ text: '🔙 REGLAS', callback_data: 'admin:rules' }]
      ] } }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^normalizetoggle:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    c.normalize = !c.normalize;
    saveStore(store);
    await ctx.answerCbQuery(c.normalize ? 'Normalización activada' : 'Normalización desactivada');
    await ctx.editMessageText('🧩 REGLAS — ' + (c.title || c.id) +
      '\n\nNormalizar espacios: ' + (c.normalize ? '🟢 Sí' : '🔴 No'),
      { reply_markup: { inline_keyboard: [
        [{ text: c.normalize ? '🔴 DESACTIVAR NORMALIZACIÓN' : '🟢 ACTIVAR NORMALIZACIÓN', callback_data: 'normalizetoggle:' + c.id }],
        [{ text: c.testMode ? '🧪 DESACTIVAR PRUEBA' : '🧪 ACTIVAR PRUEBA', callback_data: 'testmode:' + c.id }],
        [{ text: c.enabled ? '🔴 DESACTIVAR CANAL' : '🟢 ACTIVAR CANAL', callback_data: 'toggle:' + c.id }],
        [{ text: '🔙 REGLAS', callback_data: 'admin:rules' }]
      ] } }
    );
  });

  bot.action(/^testmode:(-?\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const c = ensureChannel(store, ctx.match[1]);
    c.testMode = !c.testMode;
    saveStore(store);
    await ctx.answerCbQuery(c.testMode ? 'Modo prueba activado' : 'Modo prueba desactivado');
    await ctx.editMessageText('📢 ' + (c.title || c.id) + '\n\nModo prueba: ' + (c.testMode ? '🧪 ACTIVADO' : '🟢 DESACTIVADO') +
      '\n\n' + (c.testMode ? 'Las publicaciones se enviarán como vista previa a los administradores sin editar el original.' : 'Las publicaciones volverán a editarse automáticamente.'),
      { reply_markup: { inline_keyboard: [
        [{ text: '⚙️ REGLAS', callback_data: 'ruleschannel:' + c.id }],
        [{ text: '🔙 CANAL', callback_data: 'channel:' + c.id }]
      ] } }
    );
  });

  bot.action('admin:test', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await ctx.answerCbQuery();
    await ctx.editMessageText('🧪 MODO PRUEBA\n\nActiva MODO PRUEBA dentro de cada canal. El bot enviará una vista previa a los administradores sin modificar la publicación original.', { reply_markup: { inline_keyboard: [[{ text: '📝 CREAR PUBLICACIÓN', callback_data: 'admin:publish' }], [{ text: '🔙 PANEL', callback_data: 'admin:home' }]] } });
  });

  bot.action('admin:admins', async ctx => {
    if (!rootAllowed(ctx)) return ctx.answerCbQuery('Solo el propietario del bot puede ver y gestionar administradores.');
    const roots = rootAdminIds();
    const extras = Array.isArray(store.global.adminIds) ? store.global.adminIds.map(String) : [];
    const lines = [
      '🔐 Administradores principales (ENV):',
      ...(roots.length ? roots.map(id => '• ' + id) : ['• Ninguno']),
      '',
      '👥 Administradores añadidos desde el panel:',
      ...(extras.length ? extras.map(id => '• ' + id) : ['• Ninguno'])
    ];
    const rows = [];
    if (rootAllowed(ctx)) {
      rows.push([{ text: '➕ AÑADIR ADMINISTRADOR', callback_data: 'admin:addadmin' }]);
      for (const id of extras) rows.push([{ text: '❌ QUITAR ' + id, callback_data: 'admin:removeadmin:' + id }]);
    }
    rows.push([{ text: '🔙 PANEL', callback_data: 'admin:home' }]);
    await ctx.editMessageText(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    await ctx.answerCbQuery();
  });

  bot.action('admin:addadmin', async ctx => {
    if (!rootAllowed(ctx)) return ctx.answerCbQuery('Solo el propietario del bot puede cambiar la lista.');
    setSession(ctx, { action: 'addadmin' });
    await ctx.answerCbQuery();
    await ctx.reply('👥 AÑADIR ADMINISTRADOR\n\nEnvíame el ID numérico de Telegram del nuevo administrador.\n\n/cancel para cancelar.');
  });

  bot.action(/^admin:removeadmin:(\d+)$/, async ctx => {
    if (!rootAllowed(ctx)) return ctx.answerCbQuery('Solo el propietario del bot puede cambiar la lista.');
    const id = ctx.match[1];
    store.global.adminIds = (store.global.adminIds || []).map(String).filter(value => value !== id);
    saveStore(store);
    await ctx.answerCbQuery('Administrador eliminado');
    const roots = rootAdminIds();
    const extras = store.global.adminIds;
    const lines = ['🔐 Administradores principales (ENV):', ...(roots.length ? roots.map(value => '• ' + value) : ['• Ninguno']), '', '👥 Administradores añadidos desde el panel:', ...(extras.length ? extras.map(value => '• ' + value) : ['• Ninguno'])];
    const rows = [[{ text: '➕ AÑADIR ADMINISTRADOR', callback_data: 'admin:addadmin' }], ...extras.map(value => [{ text: '❌ QUITAR ' + value, callback_data: 'admin:removeadmin:' + value }]), [{ text: '🔙 PANEL', callback_data: 'admin:home' }]];
    await ctx.editMessageText(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
  });

  bot.action('admin:history', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const items = Object.values(store.publications || {}).slice(-10).reverse();
    await ctx.answerCbQuery();
    await ctx.editMessageText('📋 HISTORIAL\n\n' + (items.length ? items.map(p => '• ' + p.id + ' — ' + (p.mode === 'paid' ? '⭐ PREMIUM' : '🆓 GRATUITA') + ' — ' + p.status).join('\n') : 'Sin publicaciones registradas.'), { reply_markup: { inline_keyboard: [[{ text: '🔙 PANEL', callback_data: 'admin:home' }]] } });
  });

  bot.action(/^paymentresolve:([a-z0-9]+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const notice = (store.paymentNotices || []).find(item => item.id === ctx.match[1]);
    if (!notice) return ctx.answerCbQuery('Este aviso de pago ya no existe.');
    if (notice.resolvedAt) return ctx.answerCbQuery('Este aviso de pago ya fue resuelto.');

    notice.resolvedAt = new Date().toISOString();
    notice.resolvedBy = String(ctx.from?.id || '');
    saveStore(store);

    await Promise.all((notice.notifications || []).map(async item => {
      try {
        await ctx.telegram.deleteMessage(Number(item.chatId), Number(item.messageId));
      } catch (err) {
        console.warn('[PAYMENT NOTICE DELETE]', item.chatId, item.messageId, err.description || err.message);
      }
    }));
    notice.notifications = [];
    saveStore(store);
    return ctx.answerCbQuery('Aviso de pago resuelto y borrado para todos.');
  });

  bot.action('admin:alerts', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const alerts = (store.alerts || []).filter(a => !a.resolvedAt).slice(-6).reverse();
    const body = alerts.length
      ? alerts.map(a => '• [' + a.type + '] ' + a.message + '\n  ' + a.at).join('\n')
      : 'No hay alertas registradas.';
    await ctx.editMessageText('🚨 ALERTAS RECIENTES\n\n' + body, { reply_markup: { inline_keyboard: [
      [{ text: '🧹 LIMPIAR ALERTAS', callback_data: 'admin:clearalerts' }],
      [{ text: '🔙 PANEL', callback_data: 'admin:home' }]
    ] } });
    await ctx.answerCbQuery();
  });

  bot.action('admin:clearalerts', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    store.alerts = [];
    saveStore(store);
    await ctx.editMessageText('🚨 Alertas eliminadas.', { reply_markup: { inline_keyboard: [[{ text: '🔙 ALERTAS', callback_data: 'admin:alerts' }], [{ text: '🔙 PANEL', callback_data: 'admin:home' }]] } });
    await ctx.answerCbQuery('Alertas limpiadas');
  });

  bot.action('admin:backup', async ctx => {
    if (!rootAllowed(ctx)) return ctx.answerCbQuery('Solo un administrador principal puede exportar el backup.');
    await ctx.answerCbQuery();
    try {
      const payload = JSON.stringify(store, null, 2);
      await ctx.replyWithDocument({
        source: Buffer.from(payload, 'utf8'),
        filename: 'canales-bot-backup.json'
      }, {
        caption: '💾 BACKUP DE CANALES-BOT\n\nGuarda este archivo fuera del hosting para poder restaurarlo después.',
        reply_markup: { inline_keyboard: [
          [{ text: '♻️ RESTAURAR BACKUP', callback_data: 'admin:restore' }],
          [{ text: '🔙 PANEL', callback_data: 'admin:home' }]
        ] }
      });
    } catch (err) {
      console.error('[BACKUP]', err.description || err.message);
      recordAlert(store, 'backup', err.description || err.message);
      await ctx.reply('❌ No pude generar el backup: ' + (err.description || err.message));
    }
  });

  bot.action('admin:restore', async ctx => {
    if (!rootAllowed(ctx)) return ctx.answerCbQuery('Solo un administrador principal puede restaurar el backup.');
    setSession(ctx, { action: 'restore' });
    await ctx.answerCbQuery();
    await ctx.reply('♻️ RESTAURAR BACKUP\n\nEnvíame el archivo JSON exportado por Canales-bot. La restauración reemplazará la configuración actual.\n\n/cancel para cancelar.');
  });

  bot.on('document', async (ctx, next) => {
    if (!rootAllowed(ctx)) return next();
    const session = getSession(ctx);
    if (!session || session.action !== 'restore') return next();
    const document = ctx.message.document;
    if (!document || Number(document.file_size || 0) > 10 * 1024 * 1024) {
      return ctx.reply('❌ El archivo no es válido o supera el límite de 10 MB.');
    }
    try {
      const fileUrl = await ctx.telegram.getFileLink(document.file_id);
      const response = await fetch(String(fileUrl));
      if (!response.ok) throw new Error('No pude descargar el archivo de Telegram.');
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > 10 * 1024 * 1024) throw new Error('El backup supera el límite de 2 MB.');
      const backup = JSON.parse(raw);
      if (!backup || typeof backup.channels !== 'object' || Array.isArray(backup.channels) ||
          !backup.global || typeof backup.global !== 'object') {
        throw new Error('El JSON no tiene la estructura de un backup de Canales-bot.');
      }

      for (const [id, channel] of Object.entries(backup.channels)) {
        if (!id || !channel || typeof channel !== 'object' || Array.isArray(channel)) {
          throw new Error('El backup contiene un canal inválido.');
        }
      }

      store.channels = backup.channels;
      store.global = {
        ...store.global,
        ...backup.global,
        templates: { ...store.global.templates, ...(backup.global.templates || {}) },
        formats: { ...store.global.formats, ...(backup.global.formats || {}) },
        adminIds: Array.isArray(backup.global.adminIds) ? backup.global.adminIds.map(String).filter(id => /^\d+$/.test(id)) : []
      };
      store.publications = backup.publications && typeof backup.publications === 'object' && !Array.isArray(backup.publications) ? backup.publications : {};
      store.purchases = backup.purchases && typeof backup.purchases === 'object' && !Array.isArray(backup.purchases) ? backup.purchases : {};
      store.stats = { ...store.stats, ...(backup.stats || {}) };
      store.alerts = Array.isArray(backup.alerts) ? backup.alerts.slice(-100) : [];

      for (const [id, channel] of Object.entries(store.channels)) {
        ensureChannel(store, id, channel.title || '');
      }
      saveStore(store);
      clearSession(ctx);
      await ctx.reply('✅ Backup restaurado correctamente.\n\nCanales: ' + Object.keys(store.channels).length +
        '\nPublicaciones: ' + Object.keys(store.publications).length +
        '\nCompras registradas: ' + Object.keys(store.purchases).length);
    } catch (err) {
      console.error('[RESTORE]', err.description || err.message);
      recordAlert(store, 'restore', err.description || err.message);
      await ctx.reply('❌ No pude restaurar el backup: ' + (err.description || err.message));
    }
  });

  bot.action('admin:templates', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await showChannels(ctx, store, true);
    await ctx.answerCbQuery('Selecciona un canal');
  });
  bot.action('admin:hashtags', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await showChannels(ctx, store, true);
    await ctx.answerCbQuery('Selecciona un canal');
  });
  bot.action('admin:buttons', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    await showChannels(ctx, store, true);
    await ctx.answerCbQuery('Selecciona un canal');
  });
  bot.action('admin:settings', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Sin permiso');
    const channels = await visibleChannels(ctx, store);
    const rows = channels.map(c => [{ text: '⚙️ ' + (c.title || c.id), callback_data: 'ruleschannel:' + c.id }]);
    rows.push([{ text: '🔙 PANEL', callback_data: 'admin:home' }]);
    await ctx.editMessageText('⚙️ CONFIGURACIÓN POR CANAL\n\nSelecciona un canal para cambiar normalización, modo prueba y estado:', { reply_markup: { inline_keyboard: rows } });
    await ctx.answerCbQuery();
  });

  bot.on('text', async (ctx, next) => {
    if (!allowed(ctx) || ctx.message.text.startsWith('/')) return next();
    const s = getSession(ctx);
    if (!s) return next();

    if (s.action === 'addchannel') return addChannelFromId(ctx, store, ctx.message.text);

    if (s.action === 'addadmin') {
      if (!rootAllowed(ctx)) { clearSession(ctx); return ctx.reply('⛔ Solo el propietario del bot puede agregar administradores.'); }
      const id = ctx.message.text.trim();
      if (!/^\d+$/.test(id)) return ctx.reply('❌ El ID debe ser numérico. Inténtalo de nuevo o usa /cancel.');
      if (rootAdminIds().includes(id) || configuredAdminIds().includes(id) || store.global.adminIds.map(String).includes(id)) {
        clearSession(ctx);
        return ctx.reply('ℹ️ Ese ID ya tiene permisos de administrador.');
      }
      store.global.adminIds.push(id);
      saveStore(store);
      clearSession(ctx);
      return ctx.reply('✅ Administrador añadido: ' + id);
    }

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
      if (!text || text.length > 64 || !['url', 'callback'].includes(type) || !destination) {
        return ctx.reply('❌ Texto (máximo 64 caracteres), tipo y destino son obligatorios.');
      }
      if (type === 'url') {
        try {
          const parsedUrl = new URL(destination);
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocol');
        } catch {
          return ctx.reply('❌ La URL debe ser válida y comenzar con http:// o https://');
        }
      }
      if (type === 'callback' && Buffer.byteLength(destination, 'utf8') > 64) return ctx.reply('❌ callback_data debe tener entre 1 y 64 bytes.');
      if (style && !['primary', 'success', 'danger'].includes(style.toLowerCase())) return ctx.reply('❌ Estilo: primary, success o danger.');
      if (emojiId && !/^\d+$/.test(emojiId)) return ctx.reply('❌ El ID de Emoji Premium debe ser numérico.');
      const row = Number.isInteger(Number(rowRaw)) && Number(rowRaw) >= 0 ? Math.min(Number(rowRaw), 99) : 0;
      const button = { text, type, ...(type === 'url' ? { url: destination } : { callback_data: destination }), ...(style ? { style: style.toLowerCase() } : {}), ...(emojiId ? { icon_custom_emoji_id: emojiId } : {}), row };
      const c = ensureChannel(store, s.channelId);
      if (s.index === undefined) c.buttons.push(button); else c.buttons[s.index] = button;
      saveStore(store); clearSession(ctx);
      return ctx.reply('✅ Botón guardado con Style de Telegram' + (emojiId ? ' + Emoji Premium.' : '.'));
    }
  });
}
