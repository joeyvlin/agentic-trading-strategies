/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./public/**/*.html",
    "./public/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        // Background layers
        surface: {
          DEFAULT: '#0e1116',   // page bg
          card:    '#161b24',   // card bg
          inset:   '#1c2230',   // nested card / inset
          hover:   '#1f2937',   // hover states
        },
        // Borders
        edge: {
          DEFAULT: '#2a3140',
          light:   '#3a4255',
        },
        // Brand accent (gold)
        gold: {
          DEFAULT:  '#c4a35a',
          dim:      '#8a7340',
          bright:   '#e0c070',
          muted:    '#9c7e3a',
        },
        // Status colors
        ok:      '#6bbf8a',
        danger:  '#c45c5c',
        warn:    '#d4a043',
        // Text
        ink: {
          DEFAULT: '#e8ecf4',   // primary text
          muted:   '#8b95a8',   // secondary text
          subtle:  '#5a6478',   // very muted
        },
      },
      fontFamily: {
        sans:    ['DM Sans', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
      },
      borderRadius: {
        card: '10px',
      },
      boxShadow: {
        card:  '0 2px 8px rgba(0,0,0,0.4)',
        modal: '0 8px 32px rgba(0,0,0,0.7)',
      },
      animation: {
        'slide-in': 'slide-in 0.2s ease-out',
        'modal-in': 'modal-in 0.15s ease-out',
      },
      keyframes: {
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(100%)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
        'modal-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(-4px)' },
          to:   { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
