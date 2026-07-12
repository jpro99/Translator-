import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.VERCEL
  ? '/'
  : (process.env.GITHUB_ACTIONS ? '/Translator-/' : '/');

export default defineConfig({
  // GitHub Pages serves under /Translator-/; Vercel / local use root.
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Language Translator',
        short_name: 'Translator',
        description: 'Real-time conversation translator',
        theme_color: '#f2f2f7',
        background_color: '#f2f2f7',
        display: 'standalone',
        orientation: 'portrait',
        // Absolute path — relative "./" can open a blank screen on some Android PWAs.
        start_url: base,
        scope: base,
        id: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/translate\.googleapis\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'gtx-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 500, maxAgeSeconds: 3600 },
            },
          },
          {
            urlPattern: /^https:\/\/api\.mymemory\.translated\.net\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'mymemory-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 500, maxAgeSeconds: 3600 },
            },
          },
          {
            urlPattern: /^https:\/\/lingva\.ml\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'lingva-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 300, maxAgeSeconds: 3600 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
});
