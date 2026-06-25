/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/web/index.html', './src/web/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * Charte Matera — service TRANSACTION (bordeaux).
         * On n'utilise NI le bleu/violet (service Property) NI le vert (service
         * Rental) : « à chaque service sa colorimétrie ».
         * Couleurs de marque : #721C1F (bordeaux), #B78874 (sable), #FAF5EE
         * (crème), #FFF9CD (jaune pâle). Neutres = gamme slate de Tailwind.
         */
        // Alias historique `matera-*` repointé sur le bordeaux (limite le diff).
        matera: {
          900: '#4A1214', // header, gros chiffres, état sélectionné
          700: '#721C1F', // bordeaux charte — boutons primaires, liens
          500: '#9C3E42', // bordeaux clair — bouton secondaire, focus ring
          100: '#F6DEDF', // teinte légère — badges/pastilles
        },
        bordeaux: {
          50: '#FBF1F1',
          100: '#F6DEDF',
          200: '#EBBEC0',
          300: '#DB9598',
          400: '#C2666A',
          500: '#9C3E42',
          600: '#721C1F', // couleur de marque (charte)
          700: '#5E171A',
          800: '#4A1214',
          900: '#360D0F',
        },
        sable: {
          50: '#FAF5F1',
          100: '#F1E5DD',
          200: '#E5CDBF',
          300: '#D4AF9B',
          400: '#C59C84',
          500: '#B78874', // sable charte (secondaire Transaction)
          600: '#9E6F5B',
          700: '#80594A',
          800: '#5E4237',
          900: '#3F2D26',
        },
        creme: '#FAF5EE', // fond de page (charte)
        pale: '#FFF9CD', // jaune pâle (charte) — accents discrets
      },
    },
  },
  plugins: [],
};
