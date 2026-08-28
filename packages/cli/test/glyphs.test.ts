import { describe, it, expect, vi } from 'vitest';
import { glyphs, PRETTY, SAFE } from '../src/tui/glyphs.js';

describe('glyphs', () => {
  const stringKeys: (keyof GlyphSet)[] = [
    'brand', 'prompt', 'hairline', 'bullet', 'check', 'cross',
    'gutterCorner', 'gutterBar', 'planDot', 'buildDot', 'warn',
    'dots', 'arrow', 'dash', 'swap', 'right', 'caret',
    'cornerTL', 'cornerTR', 'cornerBL', 'cornerBR', 'barV',
    'blockFull', 'blockEmpty', 'userBar', 'box'
  ];

  it('PRETTY set has all required keys', () => {
    for (const k of stringKeys) {
      expect(PRETTY[k]).toBeDefined();
      expect(typeof PRETTY[k]).toBe('string');
    }
    expect(PRETTY.safe).toBe(true);
  });

  it('SAFE set has all required keys with ASCII values', () => {
    for (const k of stringKeys) {
      expect(SAFE[k]).toBeDefined();
      expect(typeof SAFE[k]).toBe('string');
    }
    expect(SAFE.safe).toBe(false);
  });

  it('glyphs() returns cached value', () => {
    const g1 = glyphs();
    const g2 = glyphs();
    expect(g1).toBe(g2);
  });

  it('PRETTY uses Unicode characters', () => {
    // Unicode characters should have charCode > 127
    expect(PRETTY.brand.charCodeAt(0)).toBeGreaterThan(127);
    expect(PRETTY.hairline.charCodeAt(0)).toBeGreaterThan(127);
    expect(PRETTY.check.charCodeAt(0)).toBeGreaterThan(127);
  });

  it('SAFE uses only ASCII characters', () => {
    for (const v of Object.values(SAFE)) {
      if (typeof v === 'string') {
        for (const ch of v) {
          expect(ch.charCodeAt(0)).toBeLessThanOrEqual(127);
        }
      }
    }
    expect(SAFE.safe).toBe(false);
  });
});