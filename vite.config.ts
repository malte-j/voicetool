import { defineConfig, type Plugin } from 'vite'

const publicAssets = [
  'favicon.svg',
  'logo.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'fonts/SuisseIntl-Regular-WebS.woff2',
  'fonts/SuisseIntl-Medium-WebS.woff2',
  'model.onnx',
  'onnx-worker-wasm.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort.wasm.min.js',
  'success.mp3',
]

function pwaServiceWorker(): Plugin {
  return {
    name: 'voicetool-pwa-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const precacheUrls = [
        '/',
        ...Object.keys(bundle).map((fileName) => `/${fileName}`),
        ...publicAssets.map((fileName) => `/${fileName}`),
      ]

      const source = `const CACHE_NAME = 'voicetool-${Date.now()}'
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith('voicetool-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => (
          await caches.match(request, { ignoreSearch: true })
          ?? await caches.match('/')
          ?? Response.error()
        )),
    )
    return
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok && !request.headers.has('range')) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
`

      this.emitFile({
        type: 'asset',
        fileName: 'service-worker.js',
        source,
      })
    },
  }
}

export default defineConfig({
  plugins: [pwaServiceWorker()],
})
