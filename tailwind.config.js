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
          brand:          '#E8390E',
          'brand-dark':   '#C4300C',
          'brand-light':  '#FFF2EE',
          'brand-border': '#FCCAB8',
          bg:             '#FAFAF9',
          surface:        '#F4F3F1',
          raised:         '#FFFFFF',
          border:         '#E8E6E2',
          'border-strong':'#D1CEC8',
          t1:             '#18181B',
          t2:             '#52525B',
          t3:             '#A1A1AA',
          success:        '#16A34A',
          error:          '#DC2626',
        },
        // Keep legacy wk-* aliases so unchanged files still compile
        wk: {
          bg:      '#FAFAF9',
          card:    '#FFFFFF',
          surface: '#F4F3F1',
          border:  '#E8E6E2',
          text:    '#18181B',
          text2:   '#52525B',
          text3:   '#A1A1AA',
          red:     '#E8390E',
          'red-dk':'#C4300C',
          'red-bg':'#FFF2EE',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
