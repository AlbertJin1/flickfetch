/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Instrument Sans', 'Segoe UI Variable', 'Segoe UI', 'system-ui', 'sans-serif'], display: ['Bricolage Grotesque', 'Instrument Sans', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'Consolas', 'monospace'] },
      colors: {
        ink: { 950: '#07111e', 900: '#101c2d', 800: '#1b2c41' },
        brand: { 50: '#eaf9f5', 100: '#d5f3eb', 500: '#35c5a6', 600: '#1eaa90', 700: '#138b77' }
      },
      boxShadow: {
        panel: '0 8px 28px rgba(22, 43, 60, .045), 0 1px 2px rgba(22, 43, 60, .025)',
        soft: '0 5px 16px rgba(20, 63, 59, .075)'
      }
    }
  },
  plugins: []
};
