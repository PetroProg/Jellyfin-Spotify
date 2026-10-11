/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cat: {
          base: '#1e1e2e',
          mantle: '#181825',
          crust: '#11111b',
          surface0: '#313244',
          surface1: '#45475a',
          surface2: '#585b70',
          overlay0: '#6c7086',
          subtext0: '#a6adc8',
          subtext1: '#bac2de',
          text: '#cdd6f4',
          lavender: '#b4befe',
          mauve: '#cba6f7',
          pink: '#f5c2e7',
          peach: '#fab387',
          yellow: '#f9e2af',
          green: '#a6e3a1',
          teal: '#94e2d5',
          sapphire: '#74c7ec',
          blue: '#89b4fa',
          red: '#f38ba8',
        }
      }
    },
  },
  plugins: [],
}
