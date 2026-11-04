// Service Worker：電波がなくてもアプリを起動できるよう、アプリのファイルを端末に取っておく（仕様書 2・8 の手順4）
//  ・最初のページ（index.html）：電波があればいつもネットから取る（新しい版にすぐ気づけるように）。なければ取っておいたもの
//  ・JS・CSS・アイコン：取っておいたものを使う（ファイル名に ?v=版番号 がつくので、版が変われば別のファイルとして取り直す）
//  ・フォント（Google Fonts）：一度読んだら取っておく（電波がなくても同じ見た目に）
//  ・Dropbox との通信や、更新の確認（?check=）には手を出さない
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css?v=27',
  './js/main.js?v=27', './js/ui.js?v=27', './js/db.js?v=27', './js/editor.js?v=27', './js/list.js?v=27',
  './js/textfile.js?v=27', './js/sync.js?v=27', './js/dropbox.js?v=27', './js/config.js?v=27',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
const CACHE = 'serifu-' + FILES[3].split('v=')[1];
const FONT_CACHE = 'serifu-fonts';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // 古い版のファイルを片づける（フォントは残す）
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('serifu-') && k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (FONT_HOSTS.includes(u.hostname)) {
    e.respondWith(caches.open(FONT_CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { c.put(req, res.clone()); return res; }))));
    return;
  }
  if (u.origin !== location.origin) return;      // Dropbox などは触らない
  if (u.searchParams.has('check')) return;       // 更新の確認は、いつもネットへ
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', cp)); }
      return res;
    }).catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  })));
});
