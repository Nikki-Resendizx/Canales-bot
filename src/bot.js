import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createStore, recordAlert } from './store.js';
import { registerAdmin } from './admin.js';
import { registerPosts } from './posts.js';
import { registerPayments } from './payments.js';
import { registerPublications } from './publications.js';

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
registerAdmin(bot, store);
registerPosts(bot, store);
registerPayments(bot, store);
registerPublications(bot, store);

bot.command('start', (ctx) => ctx.reply('🤖 Canales-bot\n\nUsa /admin para administrar canales y plantillas.'));
bot.launch({ allowedUpdates: ['message', 'callback_query', 'channel_post', 'my_chat_member', 'pre_checkout_query'] })
  .then(() => console.log('🤖 Canales-bot iniciado.'))
  .catch(err => {
    console.error('[LAUNCH ERROR]', err.description || err.message);
    recordAlert(store, 'launch', err.description || err.message || String(err));
    process.exitCode = 1;
  });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
