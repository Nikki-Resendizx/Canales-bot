import { recordAlert } from './store.js';

const challenges = new Map();
const verified = new Map();
const MAX_CHALLENGES = 5000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function enabled() {
  const value = String(process.env.WELCOME_CAPTCHA_ENABLED ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

function configuredChannels(store) {
  const raw = String(process.env.WELCOME_CAPTCHA_CHANNEL_IDS || '').trim();
  if (!raw) return new Set(Object.keys(store.channels || {}));
  return new Set(raw.split(',').map(value => value.trim()).filter(value => /^-100\d{5,}$/.test(value)));
}

function isJoining(update) {
  const oldStatus = update?.old_chat_member?.status;
  const newStatus = update?.new_chat_member?.status;
  const user = update?.new_chat_member?.user;
  return Boolean(user && !user.is_bot &&
    ['left', 'kicked'].includes(oldStatus) &&
    ['member', 'administrator'].includes(newStatus));
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function makeChallenge() {
  const a = 2 + randomInt(8);
  const b = 1 + randomInt(8);
  const answer = a + b;
  const choices = new Set([answer]);
  while (choices.size < 3) {
    const offset = 1 + randomInt(5);
    choices.add(Math.random() < 0.5 ? Math.max(2, answer - offset) : answer + offset);
  }
  return { question: a + ' + ' + b, answer, choices: [...choices].sort(() => Math.random() - 0.5) };
}

function pruneChallenges() {
  const now = Date.now();
  for (const [key, value] of challenges) {
    if (value.expiresAt <= now) challenges.delete(key);
  }
  for (const [key, value] of verified) {
    if (value.expiresAt <= now) verified.delete(key);
  }
  while (challenges.size > MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  while (verified.size > MAX_CHALLENGES) verified.delete(verified.keys().next().value);
}

function keyFor(chatId, userId) {
  return String(chatId) + ':' + String(userId);
}

function buildKeyboard(chatId, userId, token, choices) {
  return {
    inline_keyboard: [choices.map(answer => ({
      text: String(answer),
      callback_data: ['wc', chatId, userId, token, answer].join(':')
    }))]
  };
}

export function registerWelcomeCaptcha(bot, store) {
  bot.on('chat_member', async (ctx, next) => {
    if (!enabled()) return next();
    const update = ctx.update?.chat_member;
    if (!update || !isJoining(update)) return next();

    const chatId = String(update.chat?.id || '');
    const user = update.new_chat_member.user;
    const userId = String(user.id);
    if (!store.channels?.[chatId] || !configuredChannels(store).has(chatId)) return next();

    pruneChallenges();
    const challenge = makeChallenge();
    const token = Math.random().toString(36).slice(2, 10);
    const key = keyFor(chatId, userId);
    challenges.set(key, {
      token,
      answer: challenge.answer,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      userId,
      chatId
    });

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'suscriptor';
    const text = [
      '👋 ¡Bienvenido/a, ' + name + '!',
      '',
      '🤖 Verifica que eres una persona para completar la confirmación.',
      'Pulsa la respuesta correcta:',
      '',
      '🧩 ' + challenge.question + ' = ?',
      '',
      '⏳ Tienes 10 minutos.'
    ].join('\n');

    try {
      await ctx.telegram.callApi('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: buildKeyboard(chatId, userId, token, challenge.choices),
        ephemeral_message_parameters: { receiver_user_id: Number(userId) }
      });
      console.log('[WELCOME CAPTCHA] Ephemeral challenge requested:', chatId, userId);
    } catch (err) {
      challenges.delete(key);
      console.warn('[WELCOME CAPTCHA UNSUPPORTED]', chatId, userId, err.description || err.message);
      recordAlert(store, 'welcome-captcha-unsupported',
        'Telegram rechazó o no entregó el CAPTCHA efímero para el nuevo suscriptor.',
        { channelId: chatId, userId, error: String(err.description || err.message || err).slice(0, 300) });
    }
    return next();
  });

  bot.action(/^wc:(-100\d{5,}):(\d+):([a-z0-9]+):(\d+)$/, async ctx => {
    const match = ctx.match;
    const [, chatId, userId, token, answerRaw] = match;
    if (String(ctx.from?.id) !== userId) {
      return ctx.answerCbQuery('Este CAPTCHA pertenece a otro suscriptor.');
    }

    const key = keyFor(chatId, userId);
    const challenge = challenges.get(key);
    if (!challenge || challenge.token !== token || challenge.expiresAt <= Date.now()) {
      challenges.delete(key);
      return ctx.answerCbQuery('El CAPTCHA venció. Si necesitas ayuda, contacta a un administrador.');
    }

    if (Number(answerRaw) !== challenge.answer) {
      return ctx.answerCbQuery('❌ Respuesta incorrecta. Intenta otra opción.', { show_alert: true });
    }

    challenges.delete(key);
    verified.set(key, { verifiedAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    pruneChallenges();
    await ctx.answerCbQuery('✅ Verificación completada.');
    console.log('[WELCOME CAPTCHA] Verified:', chatId, userId);
  });
}
