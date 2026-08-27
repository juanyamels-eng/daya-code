export interface DayaTheme {
  name: string;
  window: {
    border: string;
    panel: string;
    headerBg: string;
    dim: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
  };
  roles: {
    user: string;
    assistant: string;
    tool: string;
    system: string;
    diff: string;
  };
  accents: {
    build: string;
    plan: string;
    brand: string;
    success: string;
    warning: string;
    error: string;
    info: string;
  };
}

export const themes: Record<string, DayaTheme> = {
  catppuccin: {
    name: 'Catppuccin Mocha',
    window: {
      border: '#45475a',
      panel: '#11111b',
      headerBg: '#1e1e2e',
      dim: '#585b70',
    },
    text: {
      primary: '#cdd6f4',
      secondary: '#a6adc8',
      muted: '#6c7086',
    },
    roles: {
      user: '#89b4fa',
      assistant: '#cba6f7',
      tool: '#f9e2af',
      system: '#6c7086',
      diff: '#a6e3a1',
    },
    accents: {
      build: '#a6e3a1',
      plan: '#89b4fa',
      brand: '#cba6f7',
      success: '#a6e3a1',
      warning: '#f9e2af',
      error: '#f38ba8',
      info: '#89dceb',
    },
  },
  dracula: {
    name: 'Dracula',
    window: {
      border: '#44475a',
      panel: '#1e1f29',
      headerBg: '#282a36',
      dim: '#6272a4',
    },
    text: {
      primary: '#f8f8f2',
      secondary: '#f8f8f2',
      muted: '#6272a4',
    },
    roles: {
      user: '#8be9fd',
      assistant: '#bd93f9',
      tool: '#ffb86c',
      system: '#6272a4',
      diff: '#50fa7b',
    },
    accents: {
      build: '#50fa7b',
      plan: '#8be9fd',
      brand: '#ff79c6',
      success: '#50fa7b',
      warning: '#f1fa8c',
      error: '#ff5555',
      info: '#8be9fd',
    },
  },
  nord: {
    name: 'Nord',
    window: {
      border: '#434c5e',
      panel: '#2e3440',
      headerBg: '#3b4252',
      dim: '#4c566a',
    },
    text: {
      primary: '#eceff4',
      secondary: '#d8dee9',
      muted: '#4c566a',
    },
    roles: {
      user: '#88c0d0',
      assistant: '#81a1c1',
      tool: '#ebcb8b',
      system: '#4c566a',
      diff: '#a3be8c',
    },
    accents: {
      build: '#a3be8c',
      plan: '#88c0d0',
      brand: '#88c0d0',
      success: '#a3be8c',
      warning: '#ebcb8b',
      error: '#bf616a',
      info: '#88c0d0',
    },
  },
  gruvbox: {
    name: 'Gruvbox',
    window: {
      border: '#504945',
      panel: '#1d2021',
      headerBg: '#282828',
      dim: '#7c6f64',
    },
    text: {
      primary: '#ebdbb2',
      secondary: '#d5c4a1',
      muted: '#7c6f64',
    },
    roles: {
      user: '#83a598',
      assistant: '#b16286',
      tool: '#fabd2f',
      system: '#7c6f64',
      diff: '#b8bb26',
    },
    accents: {
      build: '#b8bb26',
      plan: '#83a598',
      brand: '#fe8019',
      success: '#b8bb26',
      warning: '#fabd2f',
      error: '#cc241d',
      info: '#83a598',
    },
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    window: {
      border: '#414868',
      panel: '#16161e',
      headerBg: '#1a1b26',
      dim: '#565f89',
    },
    text: {
      primary: '#a9b1d6',
      secondary: '#c0caf5',
      muted: '#565f89',
    },
    roles: {
      user: '#7aa2f7',
      assistant: '#bb9af7',
      tool: '#e0af68',
      system: '#565f89',
      diff: '#9ece6a',
    },
    accents: {
      build: '#9ece6a',
      plan: '#7aa2f7',
      brand: '#7dcfff',
      success: '#9ece6a',
      warning: '#e0af68',
      error: '#f7768e',
      info: '#7dcfff',
    },
  },
  'one-dark': {
    name: 'One Dark',
    window: {
      border: '#3e4451',
      panel: '#21252b',
      headerBg: '#282c34',
      dim: '#5c6370',
    },
    text: {
      primary: '#abb2bf',
      secondary: '#abb2bf',
      muted: '#5c6370',
    },
    roles: {
      user: '#61afef',
      assistant: '#c678dd',
      tool: '#e5c07b',
      system: '#5c6370',
      diff: '#98c379',
    },
    accents: {
      build: '#98c379',
      plan: '#61afef',
      brand: '#c678dd',
      success: '#98c379',
      warning: '#e5c07b',
      error: '#e06c75',
      info: '#56b6c2',
    },
  },
};

export const THEME_NAMES = Object.keys(themes).sort();

export function getTheme(name: string): DayaTheme {
  return themes[name] ?? themes['catppuccin']!;
}

export const DEFAULT_THEME = 'catppuccin';