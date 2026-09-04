const ESC = '\u001b';
const BEL = '\u0007';

const DEFAULT_FOREGROUND = '#bddbca';
const DEFAULT_BACKGROUND = '#060b08';
const ANSI_COLORS = Object.freeze([
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#ffffff',
]);

function initialStyle() {
  return {
    foreground: null,
    background: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
  };
}

function cloneStyle(style) {
  return { ...style };
}

function styleSignature(style) {
  return [
    style.foreground || '', style.background || '',
    style.bold ? 'b' : '', style.dim ? 'd' : '', style.italic ? 'i' : '',
    style.underline ? 'u' : '', style.inverse ? 'v' : '', style.strike ? 's' : '',
  ].join('|');
}

function pushSegment(segments, text, style) {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous && styleSignature(previous.style) === styleSignature(style)) previous.text += text;
  else segments.push({ text, style: cloneStyle(style) });
}

function indexedColor(index) {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  if (value < 16) return ANSI_COLORS[value];
  if (value >= 232) {
    const grey = 8 + (value - 232) * 10;
    return `rgb(${grey}, ${grey}, ${grey})`;
  }
  const offset = value - 16;
  const red = Math.floor(offset / 36);
  const green = Math.floor((offset % 36) / 6);
  const blue = offset % 6;
  const channel = (component) => component === 0 ? 0 : 55 + component * 40;
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

function rgbColor(red, green, blue) {
  const channels = [red, green, blue].map(Number);
  if (channels.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return `rgb(${channels.join(', ')})`;
}

function applyExtendedColor(style, params, offset, target) {
  const mode = Number(params[offset + 1]);
  if (mode === 5) {
    const color = indexedColor(params[offset + 2]);
    if (color) style[target] = color;
    return offset + 3;
  }
  if (mode === 2) {
    const color = rgbColor(params[offset + 2], params[offset + 3], params[offset + 4]);
    if (color) style[target] = color;
    return offset + 5;
  }
  return offset + 1;
}

function applySgr(style, rawParams) {
  const params = rawParams.length ? rawParams.split(';').map((value) => value === '' ? 0 : Number(value)) : [0];
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (!Number.isInteger(code)) continue;
    if (code === 0) Object.assign(style, initialStyle());
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 29) style.strike = false;
    else if (code === 39) style.foreground = null;
    else if (code === 49) style.background = null;
    else if (code >= 30 && code <= 37) style.foreground = ANSI_COLORS[code - 30];
    else if (code >= 90 && code <= 97) style.foreground = ANSI_COLORS[code - 90 + 8];
    else if (code >= 40 && code <= 47) style.background = ANSI_COLORS[code - 40];
    else if (code >= 100 && code <= 107) style.background = ANSI_COLORS[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'foreground' : 'background';
      index = applyExtendedColor(style, params, index, target) - 1;
    }
  }
}

function skipOsc(input, start) {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === BEL) return index + 1;
    if (input[index] === ESC && input[index + 1] === '\\') return index + 2;
  }
  return input.length;
}

function skipCsi(input, start) {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return input.length;
}

function skipControlString(input, start) {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === ESC && input[index + 1] === '\\') return index + 2;
  }
  return input.length;
}

/** Parse terminal output into text segments and safe, structured SGR styles. */
export function parseAnsi(value) {
  const input = String(value ?? '');
  const segments = [];
  const style = initialStyle();
  let text = '';
  const flush = () => {
    pushSegment(segments, text, style);
    text = '';
  };

  for (let index = 0; index < input.length;) {
    const character = input[index];
    if (character === ESC) {
      flush();
      const next = input[index + 1];
      if (next === '[') {
        const end = skipCsi(input, index + 2);
        const sequence = input.slice(index + 2, end);
        const final = sequence.at(-1);
        if (final === 'm') applySgr(style, sequence.slice(0, -1).replace(/^[?>!]/, ''));
        index = end;
      } else if (next === ']') {
        index = skipOsc(input, index + 2);
      } else if (['P', '^', '_', 'X'].includes(next)) {
        index = skipControlString(input, index + 2);
      } else {
        // Two-byte terminal controls (save/restore cursor, keypad mode, etc.)
        // are intentionally ignored because this view is not a full emulator.
        index = Math.min(input.length, index + 2);
      }
      continue;
    }
    if (character === '\r') {
      if (input[index + 1] !== '\n') text += '\n';
      index += 1;
      continue;
    }
    const code = input.charCodeAt(index);
    if ((code < 0x20 && character !== '\n' && character !== '\t') || code === 0x7f) {
      index += 1;
      continue;
    }
    text += character;
    index += 1;
  }
  flush();
  return segments;
}

/** Return output suitable for clipboard and screen-reader text. */
export function ansiToText(value) {
  return parseAnsi(value).map((segment) => segment.text).join('');
}

function styleAttributes(style) {
  const foreground = style.inverse ? (style.background || DEFAULT_BACKGROUND) : (style.foreground || DEFAULT_FOREGROUND);
  const background = style.inverse ? (style.foreground || DEFAULT_FOREGROUND) : style.background;
  const attributes = {
    color: foreground,
    'font-weight': style.bold ? '700' : undefined,
    opacity: style.dim ? '0.72' : undefined,
    'font-style': style.italic ? 'italic' : undefined,
    'text-decoration': [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
  };
  if (background) attributes['background-color'] = background;
  return attributes;
}

/** Render ANSI output using text nodes; unsupported controls degrade safely. */
export function renderAnsi(node, value) {
  if (!node) return;
  const documentRef = node.ownerDocument || globalThis.document;
  if (!documentRef?.createDocumentFragment) {
    node.textContent = ansiToText(value);
    return;
  }
  const fragment = documentRef.createDocumentFragment();
  for (const segment of parseAnsi(value)) {
    const hasStyle = Object.values(segment.style).some(Boolean);
    if (!hasStyle) {
      fragment.append(documentRef.createTextNode(segment.text));
      continue;
    }
    const span = documentRef.createElement('span');
    span.textContent = segment.text;
    span.className = 'ansi-segment';
    for (const [property, attribute] of Object.entries(styleAttributes(segment.style))) {
      if (attribute) span.style.setProperty(property, attribute);
    }
    fragment.append(span);
  }
  node.replaceChildren(fragment);
}

