// عامل الخدمة — مطلوب لتثبيت التطبيق (PWA/APK)
// الشبكة أولًا دائمًا، والكاش احتياط فقط عند انقطاع النت
const CACHE = "alzeerr-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // الخرائط والخدمات الخارجية بدون تدخل
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
