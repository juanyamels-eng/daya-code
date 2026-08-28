import { describe, it, expect } from 'vitest';
import { themes, getTheme, THEME_NAMES, DEFAULT_THEME, DAYA_BRAND, DAYA_BRAND_SOFT, type DayaTheme } from '../src/tui/themes.js';

describe('themes', () => {
  it('exports the expected theme names', () => {
    expect(THEME_NAMES).toContain('daya');
    expect(THEME_NAMES).toContain('daya-light');
    expect(THEME_NAMES).toContain('catppuccin');
    expect(THEME_NAMES).toContain('dracula');
    expect(THEME_NAMES).toContain('nord');
    expect(THEME_NAMES).toContain('gruvbox');
    expect(THEME_NAMES).toContain('tokyo-night');
    expect(THEME_NAMES).toContain('one-dark');
  });

  it('getTheme returns a valid theme object for each name', () => {
    for (const name of THEME_NAMES) {
      const t = getTheme(name);
      expect(t).toBeDefined();
      expect(t.name).toBeDefined();
      expect(t.window).toBeDefined();
      expect(t.text).toBeDefined();
      expect(t.roles).toBeDefined();
      expect(t.accents).toBeDefined();
      expect(t.diffBg).toBeDefined();
    }
  });

  it('daya theme has brand accent as the fixed DAYA_BRAND', () => {
    const t = getTheme('daya');
    expect(t.accents.brand).toBe(DAYA_BRAND);
  });

  it('daya-light theme has brand accent as the fixed DAYA_BRAND', () => {
    const t = getTheme('daya-light');
    expect(t.accents.brand).toBe(DAYA_BRAND);
  });

  it('DAYA_BRAND is a valid hex color', () => {
    expect(DAYA_BRAND).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('DAYA_BRAND_SOFT is a valid hex color', () => {
    expect(DAYA_BRAND_SOFT).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('getTheme falls back to catppuccin for unknown names', () => {
    const t = getTheme('nonexistent');
    expect(t).toBe(getTheme('catppuccin'));
  });

  it('each theme has distinct window.panel color', () => {
    const panels = new Set(THEME_NAMES.map((n) => getTheme(n).window.panel));
    expect(panels.size).toBe(THEME_NAMES.length);
  });

  it('each theme has required accent colors', () => {
    for (const name of THEME_NAMES) {
      const t = getTheme(name);
      expect(t.accents.build).toBeDefined();
      expect(t.accents.plan).toBeDefined();
      expect(t.accents.brand).toBeDefined();
      expect(t.accents.success).toBeDefined();
      expect(t.accents.warning).toBeDefined();
      expect(t.accents.error).toBeDefined();
      expect(t.accents.info).toBeDefined();
    }
  });

  it('DEFAULT_THEME is in THEME_NAMES', () => {
    expect(THEME_NAMES).toContain(DEFAULT_THEME);
  });
});