import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createStore, recordAlert, saveStore } from './store.js';
import { registerAdmin } from './admin.js';
import { registerPosts } from './posts.js';
import { registerPayments } from './payments.js';
import { registerPublications } from './publications.js';
import { registerDistribution } from './distribution.js';
import { registerReactions } from './reactions.js';
import { registerWelcomeCaptcha } from './welcome-captcha.js';

const token = String(process.env.BOT_TOKEN || '').trim();
if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  console.error('BOT_TOKEN falta o no tiene un formato válido. Configúralo en las variables de entorno del hosting.');
  process.exit(1);
}

const adminIds = String(process.env.ADMIN_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
if (!adminIds.length || adminIds.some(id => !/^\d+$/.test(id))) {
  console.error('ADMIN_IDS debe contener uno o más IDs numéricos separados por comas.');
  process.exit(1);
}

const bot = new Telegraf(token);
const store = createStore();


bot.catch((err, ctx) => {
  console.error('[BOT ERROR]', err.description || err.message || err);
  recordAlert(store, 'bot-error', err.description || err.message || String(err), { updateType: ctx?.updateType || 'unknown' });
});
registerDistribution(bot, store);
registerAdmin(bot, store);
registerPosts(bot, store);
registerPayments(bot, store);
registerPublications(bot, store);
registerReactions(bot, store);
registerWelcomeCaptcha(bot, store);

bot.command('start', (ctx) => ctx.reply(
  '🤖 CANALES-BOT\n\n' +
  'Administra canales, aplica plantillas y publica contenido gratuito o premium.\n\n' +
  'Si vienes desde una publicación premium, usa el botón de compra del canal para recibir la factura en este chat privado.\n\n' +
  'Usa /help para ver los comandos disponibles.'
));

bot.command('help', ctx => ctx.reply(
  '📚 AYUDA — CANALES-BOT\n\n' +
  '/start — iniciar el bot y abrir compras premium desde enlaces de canal.\n' +
  '/admin — abrir el panel administrativo.\n' +
  '/addchannel -100... — registrar un canal por ID.\n' +
  '/distribution — administrar conexiones entre canales.\n' +
  '/publish — crear una publicación gratuita o premium.\n' +
  '/paysupport — solicitar ayuda con una compra.\n' +
  '/cancel — cancelar la operación actual.\n\n' +
  'Los comandos /refund y /retrydelivery están reservados a administradores.'
));

function saveDirectorySafely() {
  try { saveStore(store); }
  catch (err) { console.warn('[USER DIRECTORY SAVE]', err.message); }
}

// Reintenta hacer efectivo el baneo global cuando Telegram ya reconoce al usuario
// por un intento de entrada o por una actualización de miembro.
async function enforceGlobalBan(chatId, userId, eventType) {
  const id = String(userId || '');
  const channelId = String(chatId || '');
  if (!/^\d+$/.test(id) || !store.channels[channelId]) return;
  const bannedIds = Array.isArray(store.global.globalBans) ? store.global.globalBans.map(String) : [];
  if (!bannedIds.includes(id)) return;
  try {
    const me = await bot.telegram.getMe();
    const botMember = await bot.telegram.getChatMember(channelId, me.id);
    if (botMember?.status !== 'administrator' || botMember.can_restrict_members !== true) {
      console.warn('[GLOBAL BAN ENFORCEMENT] Missing ban permission:', channelId, id);
      return;
    }
    await bot.telegram.banChatMember(channelId, Number(id));
    console.log('[GLOBAL BAN ENFORCEMENT] Ban applied:', channelId, id, eventType);
  } catch (err) {
    console.warn('[GLOBAL BAN ENFORCEMENT]', channelId, id, err.description || err.message);
  }
}

bot.on('chat_member', async ctx => {
  const update = ctx.update.chat_member;
  if (!update) return;
  const chatId = update.chat?.id;
  const member = update.new_chat_member;
  const user = member?.user;
  const userId = user?.id;
  if (userId && user?.username && /^[A-Za-z0-9_]{5,32}$/.test(user.username)) {
    if (!store.global.userDirectory || typeof store.global.userDirectory !== 'object') store.global.userDirectory = {};
    store.global.userDirectory[user.username.toLowerCase()] = String(userId);
    saveDirectorySafely();
  }
  if (!userId || ['left', 'kicked'].includes(member?.status)) return;
  await enforceGlobalBan(chatId, userId, 'chat_member');
});

bot.on('chat_join_request', async ctx => {
  const request = ctx.update.chat_join_request;
  if (!request) return;
  const chatId = request.chat?.id;
  const user = request.from;
  const userId = user?.id;
  if (userId && user?.username && /^[A-Za-z0-9_]{5,32}$/.test(user.username)) {
    if (!store.global.userDirectory || typeof store.global.userDirectory !== 'object') store.global.userDirectory = {};
    store.global.userDirectory[user.username.toLowerCase()] = String(userId);
    saveDirectorySafely();
  }
  const id = String(userId || '');
  const bannedIds = Array.isArray(store.global.globalBans) ? store.global.globalBans.map(String) : [];
  if (!bannedIds.includes(id) || !store.channels[String(chatId)]) return;
  try {
    await ctx.telegram.declineChatJoinRequest(chatId, Number(id));
    console.log('[GLOBAL BAN ENFORCEMENT] Join request declined:', chatId, id);
  } catch (err) {
    console.warn('[GLOBAL BAN JOIN REQUEST]', chatId, id, err.description || err.message);
  }
  await enforceGlobalBan(chatId, userId, 'chat_join_request');
});

bot.on('callback_query', async (ctx, next) => {
  if (!ctx.callbackQuery?.data) return next();
  await ctx.answerCbQuery('Este botón no tiene una acción configurada.');
});

bot.launch({ allowedUpdates: ['message', 'callback_query', 'channel_post', 'my_chat_member', 'chat_member', 'chat_join_request', 'pre_checkout_query', 'message_reaction', 'message_reaction_count'] })
  .then(() => console.log('🤖 Canales-bot iniciado.'))
  .catch(err => {
    console.error('[LAUNCH ERROR]', err.description || err.message);
    recordAlert(store, 'launch', err.description || err.message || String(err));
    process.exitCode = 1;
  });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
