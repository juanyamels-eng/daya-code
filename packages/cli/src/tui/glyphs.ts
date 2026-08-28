export interface GlyphSet {
  brand: string;
  prompt: string;
  hairline: string;
  bullet: string;
  check: string;
  cross: string;
  gutterCorner: string;
  gutterBar: string;
  planDot: string;
  buildDot: string;
  warn: string;
  dots: string;
  arrow: string;
  dash: string;
  swap: string;
  right: string;
  caret: string;
  cornerTL: string;
  cornerTR: string;
  cornerBL: string;
  cornerBR: string;
  barV: string;
  blockFull: string;
  blockEmpty: string;
  userBar: string;
  box: string;
  safe: boolean;
}

export const PRETTY: GlyphSet = {
  brand: '\u273b',
  prompt: '\u276f',
  hairline: '\u2500',
  bullet: '\u00b7',
  check: '\u2713',
  cross: '\u2717',
  gutterCorner: '\u2514',
  gutterBar: '\u2502',
  planDot: '\u25e6',
  buildDot: '\u25cf',
  warn: '\u26a0',
  dots: '\u2026',
  arrow: '\u2192',
  dash: '\u2014',
  swap: '\u21c4',
  right: '\u25b8',
  caret: '\u258d',
  cornerTL: '\u250c',
  cornerTR: '\u2510',
  cornerBL: '\u2514',
  cornerBR: '\u2518',
  barV: '\u2502',
  blockFull: '\u2588',
  blockEmpty: '\u2591',
  userBar: '\u00a6',
  box: '\u25a3',
  safe: true,
};

export const SAFE: GlyphSet = {
  brand: '*',
  prompt: '>',
  hairline: '-',
  bullet: '|',
  check: 'ok',
  cross: 'ERR',
  gutterCorner: '\\',
  gutterBar: '|',
  planDot: 'o',
  buildDot: '*',
  warn: '!',
  dots: '...',
  arrow: '->',
  dash: '-',
  swap: '<->',
  right: '>',
  caret: '|',
  cornerTL: '+',
  cornerTR: '+',
  cornerBL: '+',
  cornerBR: '+',
  barV: '|',
  blockFull: '#',
  blockEmpty: '-',
  userBar: '|',
  box: '>',
  safe: false,
};

function unicodeSafe(): boolean {
  const override = process.env.DAYA_GLYPHS;
  if (override === 'ascii') return false;
  if (override === 'pretty') return true;
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}

let cached: GlyphSet | undefined;

export function glyphs(): GlyphSet {
  if (!cached) cached = unicodeSafe() ? PRETTY : SAFE;
  return cached;
}