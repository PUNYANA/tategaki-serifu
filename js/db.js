// IndexedDB：端末内の保存（オフライン時の本体）
// docs    : { id, folder, name, text(.txt形式), updated, stats:{lines,chars} }
// folders : { name, cast:[{id,name,color,aliases}], created }
// meta    : { k, v }  … last（最後に開いた原稿のid）
//
// iPhone / iPad の Safari は、アプリを裏に回したりしばらく放置したりすると
// IndexedDB の接続を勝手に切ることがある。切れていたら開き直して1回だけやり直す。
const DB = 'tategaki-serifu', VER = 1;
let dbp = null;

function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('docs', { keyPath: 'id' });
      d.createObjectStore('folders', { keyPath: 'name' });
      d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onclose = () => { dbp = null; };
      d.onversionchange = () => { d.close(); dbp = null; };
      res(d);
    };
    r.onerror = () => { dbp = null; rej(r.error); };
    r.onblocked = () => { dbp = null; rej(new Error('blocked')); };
  });
  return dbp;
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('abort')); });
async function run(fn) {
  try { return await fn(await open()); }
  catch (e) {
    console.warn('IndexedDB retry', e);
    try { const d = await dbp; d && d.close(); } catch (_) { }
    dbp = null;
    return fn(await open());
  }
}

export const all = store => run(d => req(d.transaction(store).objectStore(store).getAll()));
export const get = (store, key) => run(d => req(d.transaction(store).objectStore(store).get(key)));
export const put = (store, ...vals) => run(d => { const t = d.transaction(store, 'readwrite'); vals.forEach(v => t.objectStore(store).put(v)); return done(t); });
export const del = (store, key) => run(d => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); return done(t); });
// 原稿とキャラ表を1回でまとめて保存
export const saveDoc = (doc, folder) => run(d => {
  const t = d.transaction(['docs', 'folders'], 'readwrite');
  t.objectStore('docs').put(doc); t.objectStore('folders').put(folder); return done(t);
});
export async function getMeta(k) { const r = await get('meta', k); return r ? r.v : undefined; }
export function setMeta(k, v) { return put('meta', { k, v }).catch(e => console.warn(e)); }

// それでも保存できなかったときの退避先（localStorage）。次の起動時に IndexedDB へ戻す
const PKEY = 'tategaki-serifu-pending';
const readPending = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}') || {}; } catch (e) { return {}; } };
export function stash(doc, folder) {
  try { const p = readPending(); p[doc.id] = { doc, folder }; localStorage.setItem(PKEY, JSON.stringify(p)); return true; } catch (e) { return false; }
}
export function unstash(id) {
  try { const p = readPending(); if (p[id]) { delete p[id]; localStorage.setItem(PKEY, JSON.stringify(p)); } } catch (e) { }
}
export async function restoreStash() {
  const p = readPending(); const ids = Object.keys(p); if (!ids.length) return 0;
  for (const id of ids) {
    const { doc, folder } = p[id]; const now = await get('docs', id);
    if (now && (now.updated || 0) > (doc.updated || 0)) continue; // 端末の方が新しければそのまま
    // キャラ表は退避したあとに変えているかもしれないので、端末にないときだけ戻す（あれば上書きしない）
    if (await get('folders', folder.name)) await put('docs', doc); else await saveDoc(doc, folder);
  }
  localStorage.removeItem(PKEY); return ids.length;
}
