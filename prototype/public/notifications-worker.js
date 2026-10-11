// Notification-only: deliberately no fetch handler, cached dashboard or private reads.
self.addEventListener("push", (event) => {
  let id = "";
  try { const data = event.data.json(); if (/^[a-f0-9-]{36}$/.test(data.event)) id = data.event; } catch {}
  event.waitUntil(self.registration.showNotification("Quarterdeck", {
    body: "A new Captain’s Call needs your attention",
    tag: id ? `quarterdeck-${id}` : "quarterdeck-call",
    data: { destination: "/#overview" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL("/#overview", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((window) => window.url === destination);
    if (client) return client.focus();
    return self.clients.openWindow(destination);
  })());
});
