/* Feiya 库存手机端 service worker
 *
 * 作用域限定 /m/ —— 只管手机 app 的外壳，完全不影响主站 feiya.tools 的行为。
 * 库存数据不在这里缓存（由页面存 localStorage，好显示“上次同步时间”）。
 */
const CACHE = 'feiya-m-v1'
// 注意：只用真实文件路径。'/m/' 会被主站的 SPA rewrite 吃掉，缓存到的会是
// React 主站的 HTML，导致离线打开手机 app 时显示错误页面。
const SHELL = [
  '/m/index.html',
  '/m/manifest.webmanifest',
  '/m/icon-192.png',
  '/m/icon-512.png',
  '/m/apple-touch-icon.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/m/')) return      // 主站的请求一概不接管
  if (url.pathname.startsWith('/api/')) return     // API 由页面处理离线回落

  // 打开 app：优先网络（拿最新版），断网回落缓存。
  // 只在访问真实文件 /m/index.html 时回写缓存 —— 访问 '/m/' 拿到的是被
  // rewrite 的主站 HTML，缓存下来会污染离线外壳。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (url.pathname === '/m/index.html' && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put('/m/index.html', copy))
          }
          return res
        })
        .catch(() => caches.match('/m/index.html'))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(request, copy))
      }
      return res
    }))
  )
})
