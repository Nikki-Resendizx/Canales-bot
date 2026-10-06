import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createStore } from './store.js';
import { registerAdmin } from './admin.js';
import { registerPosts } from './posts.js';
import { registerPayments } from './payments.js';
import { registerPublications } from './publications.js';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Falta BOT_TOKEN.');
  process.exit(1);
}

const bot = new Telegraf(token);
const store = createStore();

bot.catch((err) => console.error('[BOT ERROR]', err));
registerAdmin(bot, store);
registerPosts(bot, store);
registerPayments(bot, store);
registerPublications(bot, store);

bot.command('start', (ctx) => ctx.reply('🤖 Canales-bot\n\nUsa /admin para administrar canales y plantillas.'));
bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message', 'callback_query', 'channel_post', 'my_chat_member', 'pre_checkout_query'] }).then(() => console.log('🤖 Canales-bot iniciado.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
