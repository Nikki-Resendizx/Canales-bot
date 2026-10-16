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
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
  for (const [key, value] of verified) if (value.expiresAt <= now) verified.delete(key);
  while (challenges.size > MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  while (verified.size > MAX_CHALLENGES) verified.delete(verified.keys().next().value);
}

function keyFor(chatId, userId) {
  return String(chatId) + ':' + String(userId);
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'tg:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function parseSpecialButton(title, target, style, uniqueId) {
  const text = title.trim();
  const value = target.trim();
  if (!text || !value) return null;
  const button = { text, style };

  if (/^popup:/i.test(value) || /^alert:/i.test(value)) {
    const popupText = value.replace(/^(?:popup|alert):/i, '').trim();
    if (!popupText) return null;
    return { button: { ...button, callback_data: 'wcp:' + uniqueId }, action: { type: 'popup', text: popupText } };
  }
  if (/^rules$/i.test(value)) {
    const rulesUrl = String(process.env.WELCOME_CAPTCHA_RULES_URL || '').trim();
    if (!validUrl(rulesUrl)) return null;
    return { button: { ...button, url: rulesUrl } };
  }
  if (/^share:/i.test(value)) {
    const shareText = value.replace(/^share:/i, '').trim();
    if (!shareText) return null;
    return { button: { ...button, url: 'https://t.me/share/url?text=' + encodeURIComponent(shareText) } };
  }
  if (/^copy:/i.test(value)) {
    const copyText = value.replace(/^copy:/i, '').trim();
    if (!copyText || copyText.length > 256) return null;
    return { button: { ...button, copy_text: { text: copyText } } };
  }
  let url = value;
  if (/^t\.me\//i.test(url)) url = 'https://' + url;
  if (!validUrl(url)) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { button: { ...button, url } };
}

/**
 * Syntax per line: [#p|#r|#g] Button title - URL / popup:text / alert:text /
 * rules / share:text / copy:text. Use && to put multiple buttons on one row.
 * Blank lines create visual separation only; each non-empty line is a row.
 */
export function parseWelcomeButtonSyntax(source, token = Math.random().toString(36).slice(2, 10)) {
  const rows = [];
  const actions = new Map();
  const lines = String(source || '').split(/\r?\n/);
  let actionIndex = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const pieces = line.split(/\s*&&\s*/);
    const row = [];
    for (let piece of pieces) {
      let style = 'primary';
      if (/^#p\s+/i.test(piece)) { style = 'primary'; piece = piece.replace(/^#p\s+/i, ''); }
      else if (/^#r\s+/i.test(piece)) { style = 'danger'; piece = piece.replace(/^#r\s+/i, ''); }
      else if (/^#g\s+/i.test(piece)) { style = 'success'; piece = piece.replace(/^#g\s+/i, ''); }

      const splitAt = piece.indexOf(' - ');
      if (splitAt <= 0) continue;
      const title = piece.slice(0, splitAt).trim();
      const target = piece.slice(splitAt + 3).trim();
      const parsed = parseSpecialButton(title, target, style, token + (++actionIndex).toString(36));
      if (!parsed) continue;
      if (parsed.action) {
        const id = parsed.button.callback_data;
        parsed.button.callback_data = id;
        actions.set(id, parsed.action);
      }
      row.push(parsed.button);
    }
    if (row.length) rows.push(row);
  }
  return { rows, actions };
}

function buildKeyboard(chatId, userId, token, choices) {
  const answerRow = choices.map(answer => ({
    text: String(answer),
    callback_data: ['wc', chatId, userId, token, answer].join(':')
  }));
  const custom = parseWelcomeButtonSyntax(process.env.WELCOME_CAPTCHA_BUTTONS || '', token);
  return {
    inline_keyboard: [answerRow, ...custom.rows],
    _actions: custom.actions
  };
}

export function registerWelcomeCaptcha(bot, store) {
  const customActions = new Map();
  bot.on('chat_member', async (ctx, next) => {
    const update = ctx.update?.chat_member;
    if (!update || !isJoining(update)) return next();

    const chatId = String(update.chat?.id || '');
    const user = update.new_chat_member.user;
    const userId = String(user.id);
    const channel = store.channels?.[chatId];
    if (!channel || !configuredChannels(store).has(chatId)) return next();
    const welcomeEnabled = channel.welcomeEnabled !== false;
    const captchaEnabled = enabled() && channel.captchaEnabled !== false;
    if (!welcomeEnabled && !captchaEnabled) return next();

    pruneChallenges();
    const challenge = captchaEnabled ? makeChallenge() : null;
    const token = Math.random().toString(36).slice(2, 10);
    const key = keyFor(chatId, userId);
    if (captchaEnabled) challenges.set(key, { token, answer: challenge.answer, expiresAt: Date.now() + CHALLENGE_TTL_MS, userId, chatId });

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'suscriptor';
    const replacements = {
      nombre: name,
      username: user.username ? '@' + user.username : '',
      userid: userId,
      canal: channel.title || chatId,
      pregunta: challenge?.question || '',
      tiempo: String(CHALLENGE_TTL_MS / 60000)
    };
    const replaceVariables = value => String(value || '').replace(/\{(nombre|username|userid|canal|pregunta|tiempo)\}/gi, (_, key) => replacements[key.toLowerCase()] ?? '');
    const welcomeText = replaceVariables(channel.welcomeText || '👋 ¡Bienvenido/a, {nombre}!');
    const captchaText = replaceVariables(channel.captchaText || '🤖 Verifica que eres una persona para completar la confirmación.\nPulsa la respuesta correcta:\n\n🧩 {pregunta} = ?\n\n⏳ Tienes {tiempo} minutos.');
    const text = [welcomeEnabled ? welcomeText : '', captchaEnabled ? captchaText : ''].filter(Boolean).join('\n\n');

    try {
      const markup = captchaEnabled
        ? buildKeyboard(chatId, userId, token, challenge.choices)
        : { inline_keyboard: [] };
      for (const [id, action] of markup._actions || []) customActions.set(id, action);
      delete markup._actions;
      await ctx.telegram.callApi('sendMessage', {
        chat_id: chatId,
        text,
        ...(markup.inline_keyboard.length ? { reply_markup: markup } : {}),
        ephemeral_message_parameters: { receiver_user_id: Number(userId) }
      });
      console.log('[WELCOME/CAPTCHA] Ephemeral message requested:', chatId, userId, { welcomeEnabled, captchaEnabled });
    } catch (err) {
      if (captchaEnabled) challenges.delete(key);
      console.warn('[WELCOME CAPTCHA UNSUPPORTED]', chatId, userId, err.description || err.message);
      recordAlert(store, 'welcome-captcha-unsupported',
        'Telegram rechazó o no entregó el CAPTCHA efímero para el nuevo suscriptor.',
        { channelId: chatId, userId, error: String(err.description || err.message || err).slice(0, 300) });
    }
    return next();
  });

  bot.action(/^wcp:[a-z0-9]+$/, async ctx => {
    const action = customActions.get(ctx.callbackQuery?.data);
    if (!action) return ctx.answerCbQuery('Este botón ya no está disponible.');
    if (action.type === 'popup') return ctx.answerCbQuery(action.text.slice(0, 190), { show_alert: true });
  });

  bot.action(/^wc:(-100\d{5,}):(\d+):([a-z0-9]+):(\d+)$/, async ctx => {
    const [, chatId, userId, token, answerRaw] = ctx.match;
    if (String(ctx.from?.id) !== userId) return ctx.answerCbQuery('Este CAPTCHA pertenece a otro suscriptor.');
    const key = keyFor(chatId, userId);
    const challenge = challenges.get(key);
    if (!challenge || challenge.token !== token || challenge.expiresAt <= Date.now()) {
      challenges.delete(key);
      return ctx.answerCbQuery('El CAPTCHA venció. Si necesitas ayuda, contacta a un administrador.');
    }
    if (Number(answerRaw) !== challenge.answer) {
      challenges.delete(key);
      await ctx.answerCbQuery('❌ Respuesta incorrecta. Serás expulsado del canal.', { show_alert: true });
      try {
        // Keep the ban in place permanently; do not unban this user.
        await ctx.telegram.banChatMember(chatId, Number(userId));
        console.log('[WELCOME CAPTCHA] Permanently banned after wrong answer:', chatId, userId);
      } catch (err) {
        console.warn('[WELCOME CAPTCHA KICK FAILED]', chatId, userId, err.description || err.message);
        recordAlert(store, 'welcome-captcha-kick-failed',
          'No se pudo expulsar a un suscriptor que respondió incorrectamente al CAPTCHA.',
          { channelId: chatId, userId, error: String(err.description || err.message || err).slice(0, 300) });
      }
      return;
    }
    challenges.delete(key);
    verified.set(key, { verifiedAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    pruneChallenges();
    await ctx.answerCbQuery('✅ Verificación completada.');
    console.log('[WELCOME CAPTCHA] Verified:', chatId, userId);
  });
}
