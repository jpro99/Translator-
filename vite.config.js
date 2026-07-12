import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/Translator-/' : '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Language Translator',
        short_name: 'Translator',
        description: 'Real-time Japanese & Korean conversation translator',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Cache all app assets so it loads offline
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/translate\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'gtx-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 3600 },
            },
          },
          {
            urlPattern: /^https:\/\/api\.mymemory\.translated\.net\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'mymemory-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 3600 },
            },
          },
          {
            urlPattern: /^https:\/\/lingva\.ml\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'lingva-cache',
              expiration: { maxEntries: 300, maxAgeSeconds: 3600 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true, // expose on network so Samsung phone can connect via IP
    port: 5173,
  },
});
