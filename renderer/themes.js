// Color themes. `term` goes straight into xterm.js, `ui` styles the chrome (tab bar, borders, popups).
window.NEKO_THEMES = {
  'Tokyo Night': {
    term: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26',
      selectionBackground: '#33467c', selectionForeground: '#c0caf5',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#ff899d', brightGreen: '#9fe044', brightYellow: '#faba4a', brightBlue: '#8db0ff', brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#c0caf5',
    },
    ui: { bar: '#16161e', accent: '#7aa2f7', tabActiveBg: '#7aa2f7', tabActiveFg: '#16161e', tabBg: '#292e42', tabFg: '#737aa2', border: '#292e42', ghost: '#565f89', popupBg: '#1f2335', popupSel: '#2e3c64', muted: '#565f89', alert: '#f7768e' },
  },
  'Catppuccin Mocha': {
    term: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
      selectionBackground: '#45475a', selectionForeground: '#cdd6f4',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
    ui: { bar: '#11111b', accent: '#cba6f7', tabActiveBg: '#cba6f7', tabActiveFg: '#11111b', tabBg: '#181825', tabFg: '#7f849c', border: '#313244', ghost: '#6c7086', popupBg: '#181825', popupSel: '#313244', muted: '#6c7086', alert: '#f38ba8' },
  },
  'Kitty Classic': {
    term: {
      background: '#000000', foreground: '#dddddd', cursor: '#cccccc', cursorAccent: '#111111',
      selectionBackground: '#fffacd', selectionForeground: '#000000',
      black: '#000000', red: '#cc0403', green: '#19cb00', yellow: '#cecb00', blue: '#0d73cc', magenta: '#cb1ed1', cyan: '#0dcdcd', white: '#dddddd',
      brightBlack: '#767676', brightRed: '#f2201f', brightGreen: '#23fd00', brightYellow: '#fffd00', brightBlue: '#1a8fff', brightMagenta: '#fd28ff', brightCyan: '#14ffff', brightWhite: '#ffffff',
    },
    ui: { bar: '#000000', accent: '#00ff00', tabActiveBg: '#eeeeee', tabActiveFg: '#000000', tabBg: '#999999', tabFg: '#444444', border: '#cccccc', ghost: '#666666', popupBg: '#111111', popupSel: '#2a2a2a', muted: '#777777', alert: '#ff0000' },
  },
  'Gruvbox Dark': {
    term: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828',
      selectionBackground: '#504945', selectionForeground: '#ebdbb2',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    ui: { bar: '#1d2021', accent: '#fabd2f', tabActiveBg: '#fabd2f', tabActiveFg: '#282828', tabBg: '#3c3836', tabFg: '#a89984', border: '#3c3836', ghost: '#7c6f64', popupBg: '#32302f', popupSel: '#504945', muted: '#7c6f64', alert: '#fb4934' },
  },
  'Nord': {
    term: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: '#434c5e', selectionForeground: '#d8dee9',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    ui: { bar: '#242933', accent: '#88c0d0', tabActiveBg: '#88c0d0', tabActiveFg: '#2e3440', tabBg: '#3b4252', tabFg: '#7b88a1', border: '#3b4252', ghost: '#616e88', popupBg: '#3b4252', popupSel: '#4c566a', muted: '#616e88', alert: '#bf616a' },
  },
  'Rosé Pine': {
    term: {
      background: '#191724', foreground: '#e0def4', cursor: '#524f67', cursorAccent: '#e0def4',
      selectionBackground: '#403d52', selectionForeground: '#e0def4',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
    ui: { bar: '#13111e', accent: '#ebbcba', tabActiveBg: '#ebbcba', tabActiveFg: '#191724', tabBg: '#26233a', tabFg: '#6e6a86', border: '#26233a', ghost: '#6e6a86', popupBg: '#1f1d2e', popupSel: '#403d52', muted: '#6e6a86', alert: '#eb6f92' },
  },
};
