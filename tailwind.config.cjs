/**
 * Palette and type scale ported from the "Launch Observer UI redesign"
 * design project (GitHub-dark family).
 */
module.exports = {
  content: ['./pages/**/*.html', './pages/**/*.js'],
  theme: {
    extend: {
      // Every colour resolves through a CSS variable so the light/dark
      // switcher can repaint the whole UI without duplicate classes.
      colors: {
        'canvas': 'rgb(var(--c-canvas) / <alpha-value>)',
        'inset': 'rgb(var(--c-inset) / <alpha-value>)',
        'surface': 'rgb(var(--c-surface) / <alpha-value>)',
        'raised': 'rgb(var(--c-raised) / <alpha-value>)',
        'raised-hover': 'rgb(var(--c-raised-hover) / <alpha-value>)',
        'line': 'rgb(var(--c-line) / <alpha-value>)',
        'line-soft': 'rgb(var(--c-line-soft) / <alpha-value>)',
        'line-strong': 'rgb(var(--c-line-strong) / <alpha-value>)',
        'fg': 'rgb(var(--c-fg) / <alpha-value>)',
        'muted': 'rgb(var(--c-muted) / <alpha-value>)',
        'dim': 'rgb(var(--c-dim) / <alpha-value>)',
        'link': 'rgb(var(--c-link) / <alpha-value>)',
        'accent': 'rgb(var(--c-accent) / <alpha-value>)',
        'json-key': 'rgb(var(--c-json-key) / <alpha-value>)',
        'json-str': 'rgb(var(--c-json-str) / <alpha-value>)',
        'ok': 'rgb(var(--c-ok) / <alpha-value>)',
        'ok-solid': 'rgb(var(--c-ok-solid) / <alpha-value>)',
        'ok-solid-hover': 'rgb(var(--c-ok-solid-hover) / <alpha-value>)',
        'danger': 'rgb(var(--c-danger) / <alpha-value>)',
        'danger-solid': 'rgb(var(--c-danger-solid) / <alpha-value>)',
        'warn': 'rgb(var(--c-warn) / <alpha-value>)',
        'violet': 'rgb(var(--c-violet) / <alpha-value>)',
        'pink': 'rgb(var(--c-pink) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Noto Sans', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace']
      },
      fontSize: {
        '2xs': ['11px', '1.4'],
        xs: ['12px', '1.5'],
        sm: ['13px', '1.5'],
        base: ['14px', '1.5']
      },
      borderRadius: {
        DEFAULT: '6px',
        pill: '2em'
      }
    }
  },
  plugins: []
};
