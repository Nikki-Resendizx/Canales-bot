import { saveStore } from './store.js';

const DEFAULT_ALERT_CHAT_ID = '-1004456932813';
const MAX_REACTION_COUNT_RECORDS = 500;

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reactionKey(reaction) {
  if (!reaction || typeof reaction !== 'object') return '';
  if (reaction.type === 'emoji') return 'emoji:' + String(reaction.emoji || '');
  if (reaction.type === 'custom_emoji') return 'custom:' + String(reaction.custom_emoji_id || '');
  if (reaction.type === 'paid') return 'paid';
  return String(reaction.type || '');
}

function renderReaction(reaction) {
  if (reaction?.type === 'emoji' && reaction.emoji) return escapeHtml(reaction.emoji);
  if (reaction?.type === 'custom_emoji' && /^\d+$/.test(String(reaction.custom_emoji_id || ''))) {
    return '<tg-emoji emoji-id="' + String(reaction.custom_emoji_id) + '">✨</tg-emoji>';
  }
  if (reaction?.type === 'paid') return '⭐ Reacción de pago';
  return 'Reacción no identificada';
}

function publicationLink(chat, messageId) {
  if (chat?.username) return 'https://t.me/' + chat.username + '/' + messageId;
  const internalId = String(chat?.id || '').replace(/^-100/, '');
  if (internalId && messageId) return 'https://t.me/c/' + internalId + '/' + messageId;
  return '';
}

function mention(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || 'Usuario de Telegram';
  return '<a href="tg://user?id=' + String(user.id) + '">' + escapeHtml(name) + '</a>';
}

function destinationChatId(store) {
  const configured = String(process.env.REACTION_ALERTS_CHAT_ID || store.global?.reactionAlertsChatId || DEFAULT_ALERT_CHAT_ID).trim();
  return /^-100\d{5,}$/.test(configured) ? configured : DEFAULT_ALERT_CHAT_ID;
}

function isEnabled(store) {
  const env = String(process.env.REACTION_ALERTS_ENABLED || '').trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'no') return false;
  if (env === 'true' || env === '1' || env === 'yes') return true;
  return store.global?.reactionAlertsEnabled !== false;
}

async function sendHtmlWithFallback(telegram, chatId, html, fallbackText) {
  try {
    await telegram.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    });
  } catch (err) {
    // A custom emoji may not render in every client/context. Keep the alert useful
    // even if Telegram rejects its custom-emoji entity.
    console.warn('[REACTION ALERT HTML]', err.description || err.message);
    await telegram.sendMessage(chatId, fallbackText, {
      link_preview_options: { is_disabled: true }
    });
  }
}

export function registerReactions(bot, store) {
  bot.on('message_reaction', async ctx => {
    const update = ctx.update?.message_reaction;
    if (!isEnabled(store) || !update?.chat || !update.message_id || !update.user) return;

    const channelId = String(update.chat.id);
    const channel = store.channels?.[channelId];
    if (!channel) return;

    const previous = new Set((update.old_reaction || []).map(reactionKey));
    const added = (update.new_reaction || []).filter(reaction => !previous.has(reactionKey(reaction)));
    if (!added.length) return;

    const link = publicationLink(update.chat, update.message_id);
    const user = update.user;
    const userName = user.username ? '@' + user.username : 'Sin username';
    const chatName = channel.title || update.chat.title || 'Canal';
    const reactionHtml = added.map(renderReaction).join(' ');
    const reactionPlain = added.map(reaction => {
      if (reaction?.type === 'emoji' && reaction.emoji) return reaction.emoji;
      if (reaction?.type === 'custom_emoji') return '✨ (emoji personalizado)';
      if (reaction?.type === 'paid') return '⭐ Reacción de pago';
      return 'Reacción no identificada';
    }).join(' ');

    const html = [
      '🔔 <b>NUEVA REACCIÓN EN CANAL</b>',
      '📢 <b>Canal:</b> ' + escapeHtml(chatName),
      '🔗 <b>Publicación:</b> ' + (link ? '<a href="' + escapeHtml(link) + '">Abrir publicación</a>' : 'Enlace no disponible'),
      '👤 <b>Usuario:</b> ' + mention(user),
      '🔹 <b>Username:</b> ' + escapeHtml(userName),
      '🆔 <b>User ID:</b> <code>' + String(user.id) + '</code>',
      '✨ <b>Reacción:</b> ' + reactionHtml
    ].join('\n');

    const fallback = [
      '🔔 NUEVA REACCIÓN EN CANAL',
      '📢 Canal: ' + chatName,
      '🔗 Publicación: ' + (link || 'Enlace no disponible'),
      '👤 Usuario: ' + [user.first_name, user.last_name].filter(Boolean).join(' '),
      '🔹 Username: ' + userName,
      '🆔 User ID: ' + String(user.id),
      '✨ Reacción: ' + reactionPlain
    ].join('\n');

    try {
      await sendHtmlWithFallback(ctx.telegram, destinationChatId(store), html, fallback);
    } catch (err) {
      console.error('[REACTION ALERT SEND]', err.description || err.message);
    }
  });

  bot.on('message_reaction_count', async ctx => {
    const update = ctx.update?.message_reaction_count;
    if (!isEnabled(store) || !update?.chat || !update.message_id) return;

    const channelId = String(update.chat.id);
    const channel = store.channels?.[channelId];
    if (!channel) return;

    const counts = (update.reactions || []).map(item => ({
      key: reactionKey(item.type),
      type: item.type?.type || '',
      emoji: item.type?.emoji || '',
      customEmojiId: item.type?.custom_emoji_id || '',
      count: Number(item.total_count || 0)
    }));
    const messageKey = channelId + ':' + String(update.message_id);
    const signature = JSON.stringify(counts);
    if (!store.global.reactionCounts || typeof store.global.reactionCounts !== 'object') {
      store.global.reactionCounts = {};
    }
    const previous = store.global.reactionCounts[messageKey];
    if (previous?.signature === signature) return;

    store.global.reactionCounts[messageKey] = {
      channelId,
      messageId: Number(update.message_id),
      counts,
      signature,
      updatedAt: new Date().toISOString()
    };

    const entries = Object.entries(store.global.reactionCounts);
    if (entries.length > MAX_REACTION_COUNT_RECORDS) {
      for (const [oldKey] of entries.slice(0, entries.length - MAX_REACTION_COUNT_RECORDS)) {
        delete store.global.reactionCounts[oldKey];
      }
    }
    saveStore(store);

    // Count updates do not identify the people behind anonymous reactions.
    // Send aggregate data only; never infer a user from a count change.
    const link = publicationLink(update.chat, update.message_id);
    const summaryHtml = counts.length
      ? counts.map(item => {
          if (item.type === 'custom_emoji' && /^\d+$/.test(String(item.customEmojiId))) {
            return '<tg-emoji emoji-id="' + String(item.customEmojiId) + '">✨</tg-emoji>: ' + Number(item.count || 0);
          }
          if (item.type === 'emoji' && item.emoji) return escapeHtml(item.emoji) + ': ' + Number(item.count || 0);
          if (item.type === 'paid') return '⭐ Reacciones de pago: ' + Number(item.count || 0);
          return 'Reacción: ' + Number(item.count || 0);
        }).join('\n')
      : 'No hay conteos de reacciones disponibles.';
    const summaryPlain = counts.length
      ? counts.map(item => {
          if (item.type === 'custom_emoji') return '✨ Emoji personalizado: ' + Number(item.count || 0);
          if (item.type === 'emoji' && item.emoji) return item.emoji + ': ' + Number(item.count || 0);
          if (item.type === 'paid') return '⭐ Reacciones de pago: ' + Number(item.count || 0);
          return 'Reacción: ' + Number(item.count || 0);
        }).join('\n')
      : 'No hay conteos de reacciones disponibles.';

    const html = [
      '📊 <b>CONTEO DE REACCIONES ACTUALIZADO</b>',
      '📢 <b>Canal:</b> ' + escapeHtml(channel.title || update.chat.title || 'Canal'),
      '🔗 <b>Publicación:</b> ' + (link ? '<a href="' + escapeHtml(link) + '">Abrir publicación</a>' : 'Enlace no disponible'),
      '',
      summaryHtml
    ].join('\n');
    const fallback = [
      '📊 CONTEO DE REACCIONES ACTUALIZADO',
      '📢 Canal: ' + (channel.title || update.chat.title || 'Canal'),
      '🔗 Publicación: ' + (link || 'Enlace no disponible'),
      '',
      summaryPlain
    ].join('\n');

    try {
      await sendHtmlWithFallback(ctx.telegram, destinationChatId(store), html, fallback);
    } catch (err) {
      console.error('[REACTION COUNT ALERT]', err.description || err.message);
    }
  });
}
