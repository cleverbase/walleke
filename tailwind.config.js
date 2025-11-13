/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./**/*.{html,js}",
  ],
  theme: {
    extend: {
      fontFamily: {
        inter: ["Inter", "sans-serif"],
        headland: ['"Headland One"', "serif"],
      },
      colors: {
        brandBg: "#FAF5EB",
        textDark: "#111",
        cardBg: "#F7EFDD",
        brandBlue: "#163563",
        brandBlueHover: "#003d8c",
      },
    },
  },
  plugins: [],
};

