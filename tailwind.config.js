/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ml: {
          brand:          '#C22335',
          'brand-dark':   '#9E1A2A',
          'brand-light':  '#FBEEEC',
          'brand-border': '#F0CFC9',
          bg:             '#FAF6F0',
          surface:        '#F3EDE4',
          raised:         '#FFFDFA',
          border:         '#EAE2D6',
          'border-strong':'#D8CDBC',
          t1:             '#221D16',
          t2:             '#5D554A',
          t3:             '#A2988A',
          success:        '#3E7C4F',
          honey:          '#E9A13B',
          error:          '#C0392B',
        },
        // Keep legacy wk-* aliases so unchanged files still compile
        wk: {
          bg:      '#FAF6F0',
          card:    '#FFFDFA',
          surface: '#F3EDE4',
          border:  '#EAE2D6',
          text:    '#221D16',
          text2:   '#5D554A',
          text3:   '#A2988A',
          red:     '#C22335',
          'red-dk':'#9E1A2A',
          'red-bg':'#FBEEEC',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Instrument Sans', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        display: ['var(--font-display)', 'Fraunces', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
