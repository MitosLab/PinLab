importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyCDs3ezMtN-Nji2dk-bKq3SN3e8YLfsLYs",authDomain:"pinlab-f18c8.firebaseapp.com",projectId:"pinlab-f18c8",storageBucket:"pinlab-f18c8.firebasestorage.app",messagingSenderId:"587931590172",appId:"1:587931590172:web:544d9be8d77491a696c9d9"});
const messaging = firebase.messaging();
messaging.onBackgroundMessage(p => {
  const d = p.data || {};
  return self.registration.showNotification(d.title || 'PinLab', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' } });
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return clients.openWindow(url);
  }));
});
