/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'ct-blue': '#0d6efd',
        'ct-dark': '#212529',
        'ct-gray': '#6c757d',
        'ct-light': '#f8f9fa',
        'ct-border': '#dee2e6',
      }
    },
  },
  plugins: [],
}
