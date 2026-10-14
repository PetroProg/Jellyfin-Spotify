import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'Jellyfy',
        short_name: 'Jellyfy',
        description: 'Personal Catppuccin Music Streaming Player',
        theme_color: '#1e1e2e',
        background_color: '#1e1e2e',
        display: 'standalone',
        orientation: 'portrait',
        id: '/',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/stream/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'jellyfin-spotify-audio-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200, 206]
              }
            }
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:5050'
    }
  }
});
