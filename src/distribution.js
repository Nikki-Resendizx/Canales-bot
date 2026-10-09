import { recordAlert, saveStore } from './store.js';

const sessions = new Map();
const seen = new Set();
const albumBatches = new Map();
const key = ctx => String(ctx.from?.id || '');
const adminIds = store => [...String(process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean), ...(store.global.adminIds || []).map(String)];
const allowed = (ctx, store) => adminIds(store).includes(key(ctx));
const routesOf = store => Array.isArray(store.global.distributionRoutes) ? store.global.distributionRoutes : [];
const channelLabel = channel => (channel?.title || channel?.id || 'Canal') + ' (' + (channel?.id || '?') + ')';

async function isAdminOf(ctx, channelId) {
  try {
    const member = await ctx.telegram.getChatMember(String(channelId), Number(ctx.from.id));
    return ['creator', 'administrator'].includes(member?.status);
  } catch {
    return false;
  }
}

async function manageableChannels(ctx, store) {
  const channels = Object.values(store.channels || {}).filter(c => c.enabled !== false);
  const checked = await Promise.all(channels.map(async c => await isAdminOf(ctx, c.id) ? c : null));
  return checked.filter(Boolean);
}

function routeKeyboard(routes, store) {
  const rows = routes.map(route => {
    const source = store.channels[String(route.sourceId)];
    const target = store.channels[String(route.targetId)];
    return [{
      text: (route.enabled ? '🟢 ' : '⏸️ ') + (source?.title || route.sourceId) + ' ➜ ' + (target?.title || route.targetId),
      callback_data: 'dist:view:' + route.id
    }];
  });
  rows.push([{ text: '➕ CREAR CONEXIÓN', callback_data: 'dist:create' }]);
  rows.push([{ text: '🔙 PANEL', callback_data: 'admin:home' }]);
  return { inline_keyboard: rows };
}

function saveRoutes(store, routes) {
  store.global.distributionRoutes = routes;
  saveStore(store);
}

async function showRoutes(ctx, store, edit = true) {
  const own = routesOf(store).filter(route => String(route.ownerId) === key(ctx));
  const text = '🔀 DISTRIBUCIÓN MULTICANAL\n\nConecta canales de origen con un canal destino. El bot solo procesará publicaciones nuevas que reciba después de activar la conexión.\n\n' +
    (own.length ? 'Tus conexiones:' : 'Todavía no tienes conexiones.');
  const options = { reply_markup: routeKeyboard(own, store) };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

function chooseChannelsKeyboard(channels, prefix) {
  const rows = channels.map(channel => [{
    text: channel.title || channel.id,
    callback_data: prefix + ':' + channel.id
  }]);
  rows.push([{ text: '❌ CANCELAR', callback_data: 'dist:cancel' }]);
  return { inline_keyboard: rows };
}

async function startRoute(ctx, store) {
  const channels = await manageableChannels(ctx, store);
  if (channels.length < 2) {
    return ctx.editMessageText('🔀 DISTRIBUCIÓN MULTICANAL\n\nNecesitas al menos dos canales registrados donde tú seas administrador y donde el bot tenga permisos. Agrega los canales desde CANALES y comprueba que el bot sea administrador de ambos.', {
      reply_markup: { inline_keyboard: [[{ text: '📢 ABRIR CANALES', callback_data: 'admin:channels' }], [{ text: '🔙 DISTRIBUCIÓN', callback_data: 'admin:distribution' }]] }
    });
  }
  sessions.set(key(ctx), { sourceIds: channels.map(c => String(c.id)), step: 'source' });
  await ctx.editMessageText('1️⃣ ELIGE EL CANAL DE ORIGEN\n\nLas publicaciones nuevas de este canal se enviarán al destino que elijas después.', {
    reply_markup: chooseChannelsKeyboard(channels, 'dist:source')
  });
}

async function handleSource(ctx, store, sourceId) {
  const session = sessions.get(key(ctx));
  if (!session || session.step !== 'source') return ctx.answerCbQuery('Inicia una conexión nueva.');
  const channels = await manageableChannels(ctx, store);
  if (!channels.some(c => String(c.id) === String(sourceId))) return ctx.answerCbQuery('No tienes permisos de administrador en ese canal.');
  session.sourceId = String(sourceId);
  session.step = 'target';
  sessions.set(key(ctx), session);
  const targets = channels.filter(c => String(c.id) !== session.sourceId);
  await ctx.editMessageText('2️⃣ ELIGE EL CANAL DESTINO\n\nOrigen: ' + channelLabel(store.channels[session.sourceId]) + '\n\nEl destino debe ser distinto del origen.', {
    reply_markup: chooseChannelsKeyboard(targets, 'dist:target')
  });
}

async function handleTarget(ctx, store, targetId) {
  const session = sessions.get(key(ctx));
  if (!session || session.step !== 'target') return ctx.answerCbQuery('Inicia una conexión nueva.');
  const channels = await manageableChannels(ctx, store);
  if (!channels.some(c => String(c.id) === String(targetId))) return ctx.answerCbQuery('No tienes permisos de administrador en ese canal.');
  if (String(targetId) === String(session.sourceId)) return ctx.answerCbQuery('El origen y destino deben ser diferentes.');
  session.targetId = String(targetId);
  session.step = 'mode';
  sessions.set(key(ctx), session);
  await ctx.editMessageText('3️⃣ MODO DE ENVÍO\n\nOrigen: ' + channelLabel(store.channels[session.sourceId]) + '\nDestino: ' + channelLabel(store.channels[session.targetId]) + '\n\n↪️ Reenvío nativo: mantiene la referencia al canal original cuando Telegram lo permite.\n📄 Copia: publica una copia sin la cabecera de reenvío cuando Telegram lo permite.', {
    reply_markup: { inline_keyboard: [
      [{ text: '↪️ REENVÍO NATIVO', callback_data: 'dist:mode:forward' }],
      [{ text: '📄 COPIAR PUBLICACIÓN', callback_data: 'dist:mode:copy' }],
      [{ text: '❌ CANCELAR', callback_data: 'dist:cancel' }]
    ] }
  });
}

async function finalizeRoute(ctx, store, mode) {
  const session = sessions.get(key(ctx));
  if (!session || session.step !== 'mode') return ctx.answerCbQuery('La conexión expiró. Inténtalo otra vez.');
  const channels = await manageableChannels(ctx, store);
  if (!channels.some(c => String(c.id) === session.sourceId) || !channels.some(c => String(c.id) === session.targetId)) {
    sessions.delete(key(ctx));
    return ctx.answerCbQuery('Perdiste permisos de administrador en uno de los canales.');
  }
  const routes = routesOf(store);
  const duplicate = routes.find(r => String(r.sourceId) === session.sourceId && String(r.targetId) === session.targetId);
  if (duplicate && String(duplicate.ownerId) !== key(ctx)) {
    sessions.delete(key(ctx));
    return ctx.editMessageText('ℹ️ Ya existe una conexión entre estos canales, administrada por otro usuario. No se creó otra para evitar publicaciones duplicadas.', {
      reply_markup: { inline_keyboard: [[{ text: '🔀 VER CONEXIONES', callback_data: 'admin:distribution' }], [{ text: '🔙 PANEL', callback_data: 'admin:home' }]] }
    });
  }
  if (duplicate) {
    duplicate.mode = mode;
    duplicate.enabled = true;
    duplicate.updatedAt = new Date().toISOString();
  } else {
    routes.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      sourceId: session.sourceId,
      targetId: session.targetId,
      mode,
      enabled: true,
      ownerId: key(ctx),
      createdAt: new Date().toISOString()
    });
  }
  saveRoutes(store, routes);
  sessions.delete(key(ctx));
  await ctx.editMessageText('✅ CONEXIÓN ACTIVADA\n\n📢 Origen: ' + channelLabel(store.channels[session.sourceId]) +
    '\n🎯 Destino: ' + channelLabel(store.channels[session.targetId]) +
    '\n📦 Modo: ' + (mode === 'forward' ? 'Reenvío nativo' : 'Copia de publicación') +
    '\n\nSe procesarán las publicaciones nuevas. El bot debe permanecer como administrador con permiso para publicar en el destino.', {
      reply_markup: { inline_keyboard: [
        [{ text: '🔀 VER CONEXIONES', callback_data: 'admin:distribution' }],
        [{ text: '🔙 PANEL', callback_data: 'admin:home' }]
      ] }
    });
}

async function showRoute(ctx, store, routeId) {
  const route = routesOf(store).find(r => r.id === routeId && String(r.ownerId) === key(ctx));
  if (!route) return ctx.answerCbQuery('Conexión no encontrada.');
  const source = store.channels[String(route.sourceId)];
  const target = store.channels[String(route.targetId)];
  await ctx.editMessageText('🔀 CONEXIÓN\n\n📢 Origen: ' + channelLabel(source) +
    '\n🎯 Destino: ' + channelLabel(target) +
    '\n📦 Modo: ' + (route.mode === 'forward' ? 'Reenvío nativo' : 'Copia') +
    '\n📍 Estado: ' + (route.enabled ? '🟢 Activa' : '⏸️ Pausada') +
    '\n\nPara evitar bucles, un canal que sea destino de una conexión activa no se procesa como origen.', {
      reply_markup: { inline_keyboard: [
        [{ text: route.enabled ? '⏸️ PAUSAR' : '▶️ REANUDAR', callback_data: 'dist:toggle:' + route.id }],
        [{ text: '🗑️ ELIMINAR CONEXIÓN', callback_data: 'dist:delete:' + route.id }],
        [{ text: '🔙 CONEXIONES', callback_data: 'admin:distribution' }]
      ] }
    });
}

async function sendBatch(ctx, store, route, messages) {
  if (!messages.length || !route.enabled) return;
  const sourceId = String(route.sourceId);
  const targetId = String(route.targetId);
  const ids = [...new Set(messages.map(m => Number(m.message_id)).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!ids.length) return;
  const dedupeKey = route.id + ':' + ids.join(',');
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  if (seen.size > 10000) seen.delete(seen.values().next().value);
  try {
    if (ids.length === 1) {
      if (route.mode === 'forward') await ctx.telegram.forwardMessage(targetId, sourceId, ids[0]);
      else await ctx.telegram.copyMessage(targetId, sourceId, ids[0]);
    } else {
      const method = route.mode === 'forward' ? 'forwardMessages' : 'copyMessages';
      await ctx.telegram.callApi(method, { chat_id: targetId, from_chat_id: sourceId, message_ids: ids });
    }
    store.stats.distributed = Number(store.stats.distributed || 0) + ids.length;
    saveStore(store);
    console.log('[DISTRIBUTION]', sourceId, '->', targetId, 'messages=' + ids.length, 'mode=' + route.mode);
  } catch (err) {
    store.stats.distributionErrors = Number(store.stats.distributionErrors || 0) + 1;
    recordAlert(store, 'distribution', err.description || err.message || String(err), { routeId: route.id, sourceId, targetId, messageIds: ids });
    console.error('[DISTRIBUTION]', sourceId, '->', targetId, err.description || err.message);
  }
}

function queuePost(ctx, store, msg) {
  const sourceId = String(msg.chat?.id || '');
  const routes = routesOf(store).filter(route => route.enabled && String(route.sourceId) === sourceId && store.channels[sourceId]?.enabled !== false && store.channels[String(route.targetId)]?.enabled !== false);
  if (!routes.length) return;
  // A destination is not processed as a source, preventing route loops.
  if (routesOf(store).some(route => route.enabled && String(route.targetId) === sourceId)) return;
  const groupId = msg.media_group_id ? sourceId + ':' + msg.media_group_id : null;
  if (!groupId) {
    setTimeout(() => { for (const route of routes) sendBatch(ctx, store, route, [msg]).catch(() => {}); }, 1800);
    return;
  }
  const batch = albumBatches.get(groupId) || { ctx, messages: [], routes, timer: null };
  if (!batch.messages.some(item => item.message_id === msg.message_id)) batch.messages.push(msg);
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    albumBatches.delete(groupId);
    for (const route of batch.routes) sendBatch(batch.ctx, store, route, batch.messages).catch(() => {});
  }, 2200);
  albumBatches.set(groupId, batch);
}

export function registerDistribution(bot, store) {
  if (!store.global) store.global = {};
  if (!Array.isArray(store.global.distributionRoutes)) store.global.distributionRoutes = [];

  bot.use(async (ctx, next) => {
    if (ctx.channelPost) queuePost(ctx, store, ctx.channelPost);
    return next();
  });

  bot.command('distribution', async ctx => {
    if (!allowed(ctx, store)) return ctx.reply('⛔ Sin permiso.');
    return showRoutes(ctx, store, false);
  });

  bot.action('admin:distribution', async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    sessions.delete(key(ctx));
    await showRoutes(ctx, store, true);
    await ctx.answerCbQuery();
  });
  bot.action('dist:create', async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    await ctx.answerCbQuery();
    return startRoute(ctx, store);
  });
  bot.action('dist:cancel', async ctx => {
    sessions.delete(key(ctx));
    await ctx.editMessageText('❌ Creación de conexión cancelada.', { reply_markup: { inline_keyboard: [[{ text: '🔀 DISTRIBUCIÓN', callback_data: 'admin:distribution' }], [{ text: '🔙 PANEL', callback_data: 'admin:home' }]] } });
    await ctx.answerCbQuery();
  });
  bot.action(/^dist:source:(-?\d+)$/, async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    await handleSource(ctx, store, ctx.match[1]);
    await ctx.answerCbQuery();
  });
  bot.action(/^dist:target:(-?\d+)$/, async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    await handleTarget(ctx, store, ctx.match[1]);
    await ctx.answerCbQuery();
  });
  bot.action(/^dist:mode:(forward|copy)$/, async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    await finalizeRoute(ctx, store, ctx.match[1]);
    await ctx.answerCbQuery();
  });
  bot.action(/^dist:view:([a-z0-9]+)$/, async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    await showRoute(ctx, store, ctx.match[1]);
    await ctx.answerCbQuery();
  });
  bot.action(/^dist:toggle:([a-z0-9]+)$/, async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    const route = routesOf(store).find(r => r.id === ctx.match[1] && String(r.ownerId) === key(ctx));
    if (!route) return ctx.answerCbQuery('Conexión no encontrada.');
    route.enabled = !route.enabled;
    saveStore(store);
    await showRoute(ctx, store, route.id);
    await ctx.answerCbQuery(route.enabled ? 'Conexión reanudada' : 'Conexión pausada');
  });
  bot.action(/^dist:delete:([a-z0-9]+)$/, async ctx => {
    if (!allowed(ctx, store)) return ctx.answerCbQuery('Sin permiso');
    const route = routesOf(store).find(r => r.id === ctx.match[1] && String(r.ownerId) === key(ctx));
    if (!route) return ctx.answerCbQuery('Conexión no encontrada.');
    saveRoutes(store, routesOf(store).filter(r => r.id !== route.id));
    await showRoutes(ctx, store, true);
    await ctx.answerCbQuery('Conexión eliminada');
  });
}
