const CACHE_NAME = 'gpt-image-playground-v0.1.7'
const APP_CACHE_PREFIX = 'gpt-image-playground'
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './pwa-icon.svg']
const DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1'])
const isDevHost = DEV_HOSTNAMES.has(self.location.hostname)

async function clearAppCaches() {
  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter((key) => key.startsWith(APP_CACHE_PREFIX))
      .map((key) => caches.delete(key)),
  )
}

async function networkFirst(request, isNavigation) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      const cacheKey = isNavigation ? './index.html' : request
      await cache.put(cacheKey, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(isNavigation ? './index.html' : request)
    if (cached) {
      return cached
    }
    throw error
  }
}

self.addEventListener('install', (event) => {
  if (isDevHost) {
    event.waitUntil(clearAppCaches())
    self.skipWaiting()
    return
  }

  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (isDevHost) {
        await clearAppCaches()
        await self.registration.unregister()
        return
      }

      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key.startsWith(APP_CACHE_PREFIX))
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  if (isDevHost) return

  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(networkFirst(request, request.mode === 'navigate'))
})
