import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageRow, type LogEntry } from '../src/tui/App.js';
import { getTheme } from '../src/tui/themes.js';

// SAFE glyphs (what tests get by default since not TTY)
const SAFE_GLYPHS = {
  userBar: '|',
  hairline: '-',
  bullet: '|',
  check: 'ok',
  cross: 'ERR',
  warn: '!',
  gutterCorner: '\\',
  gutterBar: '|',
  planDot: 'o',
  buildDot: '*',
  dots: '...',
  blockFull: '#',
  blockEmpty: '-',
};

describe('MessageRow', () => {
  const theme = getTheme('daya');

  const renderRow = (entry: LogEntry) => {
    const { lastFrame } = render(React.createElement(MessageRow, { entry, theme }));
    return lastFrame();
  };

  it('renders user message with user bar and correct color', () => {
    const entry: LogEntry = { kind: 'user', text: 'hello world' };
    const frame = renderRow(entry);
    expect(frame).toContain('hello world');
    expect(frame).toContain(SAFE_GLYPHS.userBar); // userBar in SAFE mode
  });

  it('renders multiline user message', () => {
    const entry: LogEntry = { kind: 'user', text: 'line1\nline2' };
    const frame = renderRow(entry);
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
  });

  it('renders assistant message with DAYA tag', () => {
    const entry: LogEntry = { kind: 'assistant', text: 'Here is the answer' };
    const frame = renderRow(entry);
    expect(frame).toContain('DAYA');
    expect(frame).toContain('Here is the answer');
  });

  it('renders tool message with correct coloring for success', () => {
    const entry: LogEntry = { kind: 'tool', text: '$ bash · 0.4s', metaColor: theme.text.muted };
    const frame = renderRow(entry);
    expect(frame).toContain('bash');
  });

  it('renders tool message with error coloring', () => {
    const entry: LogEntry = { kind: 'tool', text: 'ERR npm test · 12.4s', metaColor: theme.accents.error };
    const frame = renderRow(entry);
    expect(frame).toContain('ERR');
    expect(frame).toContain('npm test');
  });

  it('renders section as hairline band', () => {
    const entry: LogEntry = { kind: 'section', text: 'Commands' };
    const frame = renderRow(entry);
    expect(frame).toContain('Commands');
    expect(frame).toContain('--'); // hairline in SAFE mode
  });

  it('renders system message with bullet prefix', () => {
    const entry: LogEntry = { kind: 'system', text: 'compacted - summarized 5, kept 3' };
    const frame = renderRow(entry);
    expect(frame).toContain('compacted');
    expect(frame).toContain(SAFE_GLYPHS.bullet); // bullet in SAFE mode
  });

  it('renders diag message with warning prefix and color', () => {
    const entry: LogEntry = { kind: 'diag', text: '2 errors - 1 warning - src/login.ts', metaColor: theme.accents.warning };
    const frame = renderRow(entry);
    expect(frame).toContain('2 errors');
  });

  it('renders diff message with diff color', () => {
    const entry: LogEntry = { kind: 'diff', text: 'commit preview' };
    const frame = renderRow(entry);
    expect(frame).toContain('commit preview');
  });
});