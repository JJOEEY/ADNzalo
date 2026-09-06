/** @type {import('tailwindcss').Config} */

// ── ADNzalo "Tối Executive" design tokens ──────────────────────────────────
// Toàn bộ app đi qua 3 scale remap dưới đây (gray/blue/purple), nên mọi màn
// hình dùng class chuẩn Tailwind đều tự chuyển sang navy ADN + accent cyan:
//   gray   → navy-tinted neutral (nền sâu #0b1129, card #1f2a4a, border #36405e)
//   blue   → ADN electric blue (#1261d6 → #0b3b8f → #0b1842)
//   purple → ADN cyan signal #16b8c4 (bỏ identity tím cũ)

const navyGray = {
  50:  '#f6f8fc',
  100: '#eef2f9',
  200: '#e2e8f2',
  300: '#c3cde0',
  400: '#8d9ab8',
  500: '#64748f',
  600: '#4b5673',
  700: '#36405e',
  800: '#1f2a4a',
  900: '#131c3a',
  950: '#0b1129',
};

const adnBlue = {
  50:  '#eaf1fe',
  100: '#d4e2fc',
  200: '#a9c6fa',
  300: '#7aa8f5',
  400: '#4d8df0',
  500: '#2a6fe0',
  600: '#1261d6',
  700: '#0e4fb0',
  800: '#0b3b8f',
  900: '#0b1842',
  950: '#071027',
};

const adnCyan = {
  50:  '#eafcfd',
  100: '#d3f7fa',
  200: '#a5f0f5',
  300: '#6fe6ef',
  400: '#38d4e0',
  500: '#16b8c4',
  600: '#0e9aa5',
  700: '#0b7e88',
  800: '#095f66',
  900: '#08474c',
  950: '#052f34',
};

module.exports = {
  content: [
    './index.html',
    './src/ui/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        gray: navyGray,
        blue: adnBlue,
        purple: adnCyan,
        zalo: {
          blue: '#0068ff',
          'blue-dark': '#0052cc',
          'blue-light': '#e8f4ff',
        },
        adn: {
          DEFAULT: '#0b3b8f',
          light: '#1261d6',
          cyan: '#16b8c4',
          dark: '#0b1842',
          ink: '#0b1129',
          surface: '#1f2a4a',
          glow: '#38d4e0',
        },
        sidebar: 'var(--color-sidebar)',
        'sidebar-hover': 'var(--color-sidebar-hover)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        'glow-cyan': '0 0 0 1px rgba(22, 184, 196, 0.35), 0 0 20px rgba(22, 184, 196, 0.12)',
        card: '0 1px 2px rgba(7, 16, 39, 0.4), 0 4px 16px rgba(7, 16, 39, 0.25)',
      },
    },
  },
  plugins: [],
};
