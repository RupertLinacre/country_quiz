import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = '/country_quiz/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      injectRegister: null,
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Countries Quiz',
        short_name: 'Countries Quiz',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#04131f',
        theme_color: '#04131f',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
})
