// Service worker для Web Push: уведомления приходят через push-сервис браузера (Mozilla, Google, Apple).
// Лежит в корне сайта рядом с index.html: браузер требует, чтобы он был по этому адресу.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Сервер шлёт зашифрованный JSON: {title, body, url}.
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil((async () => {
    // Если вкладка чата открыта и видна, уведомление не нужно: сообщение и так видно на экране.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible')) return;
    await self.registration.showNotification(d.title || 'Новое сообщение', {
      body: d.body || '',
      tag: 'chat-message',
      renotify: true,
      icon: './favicon.svg',
      data: { url: d.url || './' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
