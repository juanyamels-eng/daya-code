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
}

const PRETTY: GlyphSet = {
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
};

const SAFE: GlyphSet = {
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
};

function unicodeSafe(): boolean {
  if (process.platform !== 'win32') return true;
  if (!process.stdout.isTTY) return false;
  return !!(process.env.WT_SESSION || process.env.WT_PROFILE_ID || process.env.TERM_PROGRAM || process.env.ConEmuANSI || process.env.VSCODE_CWD);
}

let cached: GlyphSet | undefined;

export function glyphs(): GlyphSet {
  if (!cached) cached = unicodeSafe() ? PRETTY : SAFE;
  return cached;
}