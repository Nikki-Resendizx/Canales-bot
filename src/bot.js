import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createStore, recordAlert } from './store.js';
import { registerAdmin } from './admin.js';
import { registerPosts } from './posts.js';
import { registerPayments } from './payments.js';
import { registerPublications } from './publications.js';
import { registerDistribution } from './distribution.js';

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

bot.on('callback_query', async (ctx, next) => {
  if (!ctx.callbackQuery?.data) return next();
  await ctx.answerCbQuery('Este botón no tiene una acción configurada.');
});

bot.launch({ allowedUpdates: ['message', 'callback_query', 'channel_post', 'my_chat_member', 'pre_checkout_query'] })
  .then(() => console.log('🤖 Canales-bot iniciado.'))
  .catch(err => {
    console.error('[LAUNCH ERROR]', err.description || err.message);
    recordAlert(store, 'launch', err.description || err.message || String(err));
    process.exitCode = 1;
  });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
