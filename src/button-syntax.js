const popupTexts = new Map();
let popupSequence = 0;

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function addPopup(title, text, style, actions) {
  const id = 'sp' + (++popupSequence).toString(36) + Math.random().toString(36).slice(2, 7);
  popupTexts.set(id, text);
  const button = { text: title, callback_data: id, ...(style ? { style } : {}) };
  actions.set(id, text);
  return button;
}

function parseButton(titleRaw, targetRaw, style, actions) {
  const title = titleRaw.trim();
  const target = targetRaw.trim();
  if (!title || title.length > 64 || !target) return null;
  const button = { text: title, ...(style ? { style } : {}) };

  if (/^(?:popup|alert):/i.test(target)) {
    const popupText = target.replace(/^(?:popup|alert):/i, '').trim();
    if (!popupText) return null;
    return addPopup(title, popupText, style, actions);
  }

  if (/^share:/i.test(target)) {
    const shareText = target.replace(/^share:/i, '').trim();
    if (!shareText) return null;
    return { ...button, url: 'https://t.me/share/url?text=' + encodeURIComponent(shareText) };
  }

  if (/^copy:/i.test(target)) {
    const copyText = target.replace(/^copy:/i, '').trim();
    if (!copyText || copyText.length > 256) return null;
    return { ...button, copy_text: { text: copyText } };
  }

  let url = target;
  if (/^t\.me\//i.test(url)) url = 'https://' + url;
  if (!validHttpUrl(url)) return null;
  return { ...button, url };
}

/**
 * Parses button syntax embedded in a message/template and removes those lines
 * from the visible text. Non-button lines remain untouched.
 */
export function parseButtonSyntax(input) {
  const source = String(input ?? '');
  const lines = source.split(/\r?\n/);
  const output = [];
  const keyboard = [];
  const actions = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      output.push(rawLine);
      continue;
    }

    const pieces = line.split(/\s*&&\s*/);
    let style = '';
    let content = pieces[0];
    if (/^#p\s+/i.test(content)) { style = 'primary'; content = content.replace(/^#p\s+/i, ''); }
    else if (/^#r\s+/i.test(content)) { style = 'danger'; content = content.replace(/^#r\s+/i, ''); }
    else if (/^#g\s+/i.test(content)) { style = 'success'; content = content.replace(/^#g\s+/i, ''); }
    pieces[0] = content;

    const row = [];
    let validLine = true;
    for (let piece of pieces) {
      let pieceStyle = style;
      if (/^#p\s+/i.test(piece)) { pieceStyle = 'primary'; piece = piece.replace(/^#p\s+/i, ''); }
      else if (/^#r\s+/i.test(piece)) { pieceStyle = 'danger'; piece = piece.replace(/^#r\s+/i, ''); }
      else if (/^#g\s+/i.test(piece)) { pieceStyle = 'success'; piece = piece.replace(/^#g\s+/i, ''); }
      const separator = piece.indexOf(' - ');
      if (separator <= 0) { validLine = false; break; }
      const button = parseButton(piece.slice(0, separator), piece.slice(separator + 3), pieceStyle, actions);
      if (!button) { validLine = false; break; }
      row.push(button);
    }

    if (validLine && row.length) keyboard.push(row);
    else output.push(rawLine);
  }

  return { text: output.join('\n').trim(), keyboard, actions };
}

export function combineKeyboards(...keyboards) {
  const rows = [];
  for (const keyboard of keyboards) {
    if (!Array.isArray(keyboard)) continue;
    for (const row of keyboard) {
      if (Array.isArray(row) && row.length) rows.push(row);
    }
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

export function registerSyntaxPopupActions(bot) {
  bot.action(/^sp[a-z0-9]+$/, async ctx => {
    const text = popupTexts.get(String(ctx.callbackQuery?.data || ''));
    if (!text) return ctx.answerCbQuery('Esta ventana emergente ya no está disponible.');
    return ctx.answerCbQuery(text.slice(0, 190), { show_alert: true });
  });
}
