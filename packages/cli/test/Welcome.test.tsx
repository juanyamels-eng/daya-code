import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Welcome } from '../src/tui/App.js';
import { getTheme } from '../src/tui/themes.js';

const makeGlyphs = (safe = true) => ({
  safe,
  brand: safe ? '✻' : '*',
  prompt: safe ? '❯' : '>',
  hairline: safe ? '─' : '-',
  bullet: safe ? '·' : '|',
  check: safe ? '✓' : 'ok',
  cross: safe ? '✗' : 'ERR',
  gutterCorner: safe ? '└' : '\\',
  gutterBar: safe ? '│' : '|',
  planDot: safe ? '⦾' : 'o',
  buildDot: safe ? '●' : '*',
  warn: safe ? '⚠' : '!',
  dots: safe ? '…' : '...',
  arrow: safe ? '→' : '->',
  dash: safe ? '—' : '-',
  swap: safe ? '⇄' : '<->',
  right: safe ? '▸' : '>',
  caret: safe ? '▍' : '|',
  cornerTL: safe ? '┌' : '+',
  cornerTR: safe ? '┐' : '+',
  cornerBL: safe ? '└' : '+',
  cornerBR: safe ? '┘' : '+',
  barV: safe ? '│' : '|',
  blockFull: safe ? '█' : '#',
  blockEmpty: safe ? '░' : '-',
  userBar: safe ? '¦' : '|',
  box: safe ? '□' : '>',
});

describe('Welcome', () => {
  const theme = getTheme('daya');

  const renderWelcome = (columns = 100, rows = 40, g = makeGlyphs(true)) => {
    const { lastFrame } = render(React.createElement(Welcome, { theme, g, columns, rows }));
    return lastFrame();
  };

  it('renders something when glyphs are safe and space is available', () => {
    const frame = renderWelcome(100, 40);
    expect(frame).not.toBeNull();
    expect(typeof frame).toBe('string');
  });

  it('renders something when glyphs are safe and space is compact', () => {
    const frame = renderWelcome(50, 40);
    expect(frame).not.toBeNull();
    expect(typeof frame).toBe('string');
  });

  it('renders something when rows < 26', () => {
    const frame = renderWelcome(100, 20);
    expect(frame).not.toBeNull();
    expect(typeof frame).toBe('string');
  });

  it('renders fallback when glyphs not safe', () => {
    const gUnsafe = makeGlyphs(false);
    const frame = renderWelcome(100, 40, gUnsafe);
    expect(frame).not.toBeNull();
    expect(typeof frame).toBe('string');
  });
});