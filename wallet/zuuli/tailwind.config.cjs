/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        zuuli: {
          bg: "#09090b",
          surface: "#18181b",
          elevated: "#27272a",
          border: "#3f3f46",
          purple: "#a855f7",
          "purple-hover": "#9333ea",
          "purple-muted": "#2d1f3e",
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-up': 'slide-up 0.3s ease-out',
        'sync-breathe': 'sync-breathe 4s ease-in-out infinite',
      },
      keyframes: {
        'pulse-dot': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'sync-breathe': { '0%, 100%': { opacity: '0.3' }, '50%': { opacity: '0.6' } },
      },
      boxShadow: {
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.15)',
      },
      ringColor: {
        DEFAULT: '#a855f7',
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({
        '.min-tap': { 'min-width': '44px', 'min-height': '44px' },
      });
    },
  ],
};
