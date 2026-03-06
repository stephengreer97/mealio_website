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
        wk: {
          bg:      '#f6f1eb',
          card:    '#ffffff',
          surface: '#ede7df',
          border:  '#e2d8ce',
          text:    '#1d1a16',
          text2:   '#6a5f54',
          text3:   '#a8998b',
          red:     '#dd0031',
          'red-dk':'#b5002a',
          'red-bg':'#fff0f2',
        },
      },
      fontFamily: {
        sans: ['DM Sans', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
