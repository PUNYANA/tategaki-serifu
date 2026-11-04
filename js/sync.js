// Dropbox との同期（仕様書 6）
//  ・編集のたびに端末（IndexedDB）へ保存し、手を止めて3秒後に Dropbox へ送る
//  ・送るときは手元で知っている rev を添える（rev が食い違えば衝突）
//  ・衝突したら上書きしない。この端末の版を「第58話（iPhoneの版）」として残す。別の版は1つの原稿につき1端末1本まで（増やさず上書き）
//  ・起動時・オンラインに戻ったとき・一覧を開いたとき・画面に戻ったときに、Dropbox の変更を取り込む
//  ・ログインしていなければ何もしない（端末の中だけで使える）
// 原稿の同期用の項目： doc.path（Dropbox 上のパス）, doc.rev, doc.dirty（未送信の変更あり）
// 作品フォルダの項目： folder.synced（Dropbox にフォルダを作った）, folder.castRev, folder.castDirty
import * as dbx from './dropbox.js?v=13';
import * as db from './db.js?v=13';
import { parseDoc, docStats, setTitle } from './textfile.js?v=13';

let S = null;
const listeners = [];
export const onChange = fn => listeners.push(fn);
const emit = (ev = {}) => listeners.forEach(f => { try { f(ev); } catch (e) { console.error(e); } });

// 'local'（未ログイン）/ 'offline' / 'idle'（同期済み）/ 'busy'（送信中）/ 'error'
export let status = 'local';
export let lastError = '', lastSync = 0;

const lower = s => s.toLowerCase();
export const docPath = d => `/${d.folder}/${d.name}.txt`;
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const statsOf = (text, folder) => docStats(parseDoc(text, folder ? folder.cast : []).items);
const folderOf = name => S.folders.find(f => lower(f.name) === lower(name));

export function device() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC';
  if (/Mac/.test(ua)) return 'Mac';
  return '別の端末';
}

/* ---- 衝突の組（名前で決める。どの端末から見ても同じ印になる） ---- */
const COPY = /^(.*)（(.+)の版）$/;
export const isCopy = d => COPY.test(d.name);
// d と衝突の組になっている原稿（d が元なら別の版たち、d が別の版なら元）
export function partners(d) {
  const m = d.name.match(COPY);
  if (m) return S.docs.filter(x => x.folder === d.folder && x.name === m[1]);
  return S.docs.filter(x => x !== d && x.folder === d.folder && (x.name.match(COPY) || [])[1] === d.name);
}
export function docState(d) {
  if (!dbx.signedIn()) return null;
  if (partners(d).length) return 'conflict';
  return d.dirty || !d.rev ? 'pending' : 'synced';
}

/* ---- 起動と予約 ---- */
let chain = Promise.resolve(), pushT = 0, again = false, running = false;
export async function init(state) {
  S = state; await dbx.loadToken(); status = dbx.signedIn() ? (navigator.onLine ? 'idle' : 'offline') : 'local';
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => { if (dbx.signedIn()) { status = 'offline'; emit(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
}
// 端末に保存したら呼ぶ。手を止めて3秒後に送る
export function schedule() {
  if (!dbx.signedIn()) return;
  clearTimeout(pushT); pushT = setTimeout(() => sync('push'), 3000); emit();
}
// kind：'full'（取り込み＋送信）/ 'push'（送信だけ）。同期は1つずつ順番に行う
export function sync(kind = 'full') {
  if (!dbx.configured()) { status = 'local'; emit(); return Promise.resolve(); }
  // 別の窓（ログイン用のアプリ内ブラウザ）でログインしたかもしれないので、つないでいなければ端末の記録を読み直す
  if (!dbx.signedIn()) return dbx.loadToken().then(ok => { if (ok) return sync(kind); status = 'local'; emit(); });
  if (!navigator.onLine) { status = 'offline'; emit(); return Promise.resolve(); }
  if (running) { again = (again === 'full' || kind === 'full') ? 'full' : 'push'; return chain; } // 終わったらもう一度（取り込みを頼まれていたら取り込みも）
  running = true; clearTimeout(pushT);
  chain = (async () => {
    try { flush && flush(); } catch (e) { console.error(e); }
    status = 'busy'; emit();
    try {
      if (kind === 'full') await pull();
      await pushAll();
      status = 'idle'; lastSync = Date.now(); lastError = '';
    } catch (e) {
      console.error(e);
      if (!dbx.signedIn()) status = 'local';
      else {
        status = navigator.onLine ? 'error' : 'offline';
        lastError = e.status === 429 ? 'Dropbox が混み合っています。少し待つと送り直します'
          : e.status >= 500 ? `Dropbox との通信に失敗しました（${e.status}）。少し待つと送り直します`
          : e.status ? `Dropbox に断られました（${e.status}）：${e.summary || ''}` : 'Dropbox につながりません';
      }
    }
    running = false; emit();
    if (again) { const k = again; again = false; return sync(k); }
  })();
  return chain;
}

/* ---- 送る ---- */
async function pushAll() {
  // 1. 端末で消した原稿を Dropbox でも消す（Dropbox のゴミ箱から戻せる）
  let dels = (await db.getMeta('dbxDeletes')) || [];
  for (const p of [...dels]) {
    try { await dbx.rpc('files/delete_v2', { path: p }); } catch (e) { if (!e.notFound) throw e; }
    dels = dels.filter(x => x !== p); await db.setMeta('dbxDeletes', dels);
  }
  // 2. 作品フォルダとキャラ表
  for (const f of S.folders) {
    if (!f.synced) {
      try { await dbx.rpc('files/create_folder_v2', { path: '/' + f.name, autorename: false }); } catch (e) { if (!e.conflict) throw e; }
      f.synced = true; await db.put('folders', f);
    }
    if (f.castDirty || !f.castRev) await pushCast(f);
  }
  // 3. 原稿
  for (const d of [...S.docs]) if (d.dirty || !d.rev || (d.path && lower(d.path) !== lower(docPath(d)))) await pushDoc(d);
}

const castJson = f => JSON.stringify({ version: 1, regulars: f.cast.map(c => ({ id: c.id, name: c.name, color: c.color, aliases: c.aliases || [] })) }, null, 2) + '\n';
function readCast(text) { try { const j = JSON.parse(text); return Array.isArray(j.regulars) ? j.regulars : []; } catch (e) { return []; } }
async function pushCast(f) {
  const path = `/${f.name}/_cast.json`;
  if (!f.cast.length && !f.castRev) { f.castDirty = false; return; } // キャラがいないうちは作らない
  try {
    const m = await dbx.upload(path, castJson(f), f.castRev ? { update: f.castRev } : 'add'); f.castRev = m.rev;
  } catch (e) {
    if (!e.conflict) throw e;
    // 別の端末でもキャラ表を変えていた：両方のキャラを残して合わせる（同じキャラはこの端末の内容を優先）
    const { text } = await dbx.download(path);
    const add = readCast(text).filter(r => !f.cast.some(c => c.id === r.id));
    f.cast.push(...add);
    const m = await dbx.upload(path, castJson(f), 'overwrite'); f.castRev = m.rev;
    if (add.length) emit({ cast: f });
  }
  f.castDirty = false; await db.put('folders', f);
}

async function pushDoc(d) {
  const want = docPath(d);
  // 名前を変えた原稿は、Dropbox でも名前を変える
  if (d.path && d.rev && lower(d.path) !== lower(want)) {
    try { const r = await dbx.rpc('files/move_v2', { from_path: d.path, to_path: want, autorename: false }); d.path = r.metadata.path_display; d.rev = r.metadata.rev; }
    catch (e) { if (e.notFound) { d.path = null; d.rev = null; } else if (!e.conflict) throw e; }
    await db.put('docs', d);
  }
  if (!d.dirty && d.rev && d.path && lower(d.path) === lower(want)) return;
  try {
    // 別の版は、衝突を重ねないよう常に上書きで送る
    const mode = isCopy(d) ? 'overwrite' : (d.rev && d.path && lower(d.path) === lower(want) ? { update: d.rev } : 'add');
    const m = await dbx.upload(want, d.text, mode);
    d.path = m.path_display; d.rev = m.rev; d.dirty = false; await db.put('docs', d); emit({ doc: d });
  } catch (e) {
    if (!e.conflict) throw e;
    const r = await dbx.download(want);
    await resolveClash(d, r.text, r.meta);
  }
}

// この端末の版（d.text）と Dropbox の版（text）が食い違ったとき
async function resolveClash(d, text, meta) {
  if (text === d.text) { d.path = meta.path_display; d.rev = meta.rev; d.dirty = false; await db.put('docs', d); return; }
  const copy = await keepCopy(d, d.text);
  d.text = text; d.rev = meta.rev; d.path = meta.path_display; d.dirty = false; d.updated = Date.now(); d.stats = statsOf(text, folderOf(d.folder));
  await db.put('docs', d);
  emit({ replaced: d, conflict: copy });
  await pushDoc(copy);
}
// この端末の版を「名前（端末の版）」として残す。すでにあれば増やさずに上書き
async function keepCopy(d, text) {
  const name = `${d.name}（${device()}の版）`;
  let c = S.docs.find(x => x.folder === d.folder && x.name === name);
  if (!c) { c = { id: genId(), folder: d.folder, name }; S.docs.push(c); }
  c.text = setTitle(text, name); c.updated = Date.now(); c.dirty = true; c.stats = statsOf(c.text, folderOf(d.folder));
  await db.put('docs', c);
  return c;
}

/* ---- 取り込む ---- */
async function pull() {
  let cursor = await db.getMeta('dbxCursor'), res = null;
  if (cursor) { try { res = await dbx.rpc('files/list_folder/continue', { cursor }); } catch (e) { if (!/reset/.test(e.summary)) throw e; } }
  if (!res) res = await dbx.rpc('files/list_folder', { path: '', recursive: true, include_deleted: true });
  for (; ;) {
    for (const e of res.entries) await applyEntry(e);
    await db.setMeta('dbxCursor', res.cursor);
    if (!res.has_more) break;
    res = await dbx.rpc('files/list_folder/continue', { cursor: res.cursor });
  }
}
async function ensureFolder(name) {
  let f = folderOf(name);
  if (!f) { f = { name, cast: [], created: Date.now(), synced: true }; S.folders.push(f); await db.put('folders', f); emit({ folders: true }); }
  else if (!f.synced) { f.synced = true; await db.put('folders', f); }
  return f;
}
async function applyEntry(e) {
  const parts = (e.path_display || e.path_lower || '').split('/').filter(Boolean);
  const tag = e['.tag'];
  if (tag === 'folder') { if (parts.length === 1) await ensureFolder(parts[0]); return; }
  if (parts.length !== 2) return; // 作品フォルダの直下だけ（作品フォルダの中のフォルダは今は扱わない）
  const [fname, file] = parts;
  // キャラ表（_cast.json）
  if (lower(file) === '_cast.json') {
    if (tag !== 'file') return;
    const f = await ensureFolder(fname);
    if (f.castRev === e.rev || f.castDirty) return; // 端末側に未送信の変更があれば、送るときに合わせる
    const { text } = await dbx.download(e.path_lower);
    const regs = readCast(text);
    f.cast.splice(0, f.cast.length, ...regs.map(r => ({ id: r.id, name: r.name, color: r.color, aliases: r.aliases || [] })));
    f.castRev = e.rev; await db.put('folders', f); emit({ cast: f });
    return;
  }
  if (/^[_.]/.test(file) || !/\.txt$/i.test(file)) return; // _ で始まるファイルなどは一覧に出さない
  const name = file.replace(/\.txt$/i, '');
  const local = S.docs.find(d => d.path && lower(d.path) === e.path_lower) || S.docs.find(d => !d.path && lower(docPath(d)) === e.path_lower);
  if (tag === 'deleted') {
    if (!local || !local.rev) return;
    if (local.dirty) { local.rev = null; local.path = null; await db.put('docs', local); return; } // 端末で書き足していたら、消さずに送り直す
    S.docs.splice(S.docs.indexOf(local), 1); await db.del('docs', local.id); emit({ removed: local });
    return;
  }
  if (tag !== 'file') return;
  if (local && local.rev === e.rev) return;
  const { text, meta } = await dbx.download(e.path_lower);
  if (!local) {
    const f = await ensureFolder(fname);
    const d = { id: genId(), folder: f.name, name, text, rev: meta.rev, path: meta.path_display, dirty: false, updated: Date.parse(e.server_modified) || Date.now(), stats: statsOf(text, f) };
    S.docs.push(d); await db.put('docs', d); emit({ added: d });
    return;
  }
  if (!local.dirty && local.rev) {
    local.text = text; local.rev = meta.rev; local.path = meta.path_display; local.updated = Date.parse(e.server_modified) || Date.now(); local.stats = statsOf(text, folderOf(local.folder));
    await db.put('docs', local); emit({ replaced: local });
    return;
  }
  await resolveClash(local, text, meta); // 端末にも未送信の変更がある
}

/* ---- 一覧からの操作 ---- */
// 原稿を消した：Dropbox にあるものは、次の同期で Dropbox からも消す
export async function removed(d) {
  if (d.path && d.rev) { const dels = (await db.getMeta('dbxDeletes')) || []; dels.push(d.path); await db.setMeta('dbxDeletes', dels); }
  schedule();
}
// 衝突の片づけ：keep を残し、組のもう一方を消す。別の版を残すときは、その中身を元の名前の原稿に移す
export async function resolve(keep) {
  const m = keep.name.match(COPY);
  if (m) {
    const orig = S.docs.find(x => x.folder === keep.folder && x.name === m[1]);
    if (orig) {
      orig.text = setTitle(keep.text, orig.name); orig.dirty = true; orig.updated = Date.now(); orig.stats = keep.stats; await db.put('docs', orig);
      for (const c of partners(orig)) await dropDoc(c);
      emit({ replaced: orig }); schedule(); return orig;
    }
    return keep;
  }
  for (const c of partners(keep)) await dropDoc(c);
  schedule(); return keep;
}
async function dropDoc(d) { S.docs.splice(S.docs.indexOf(d), 1); await db.del('docs', d.id); await removed(d); emit({ removed: d }); }

export const signIn = () => dbx.signIn();
// ログアウト：同期の記録は消す（次につないだときは、初めてつないだときと同じように端末と Dropbox を合わせる）。原稿は消さない
export async function signOut() {
  await dbx.signOut();
  for (const d of S.docs) { if (d.path || d.rev) { d.path = null; d.rev = null; await db.put('docs', d); } }
  for (const f of S.folders) { if (f.synced || f.castRev) { f.synced = false; f.castRev = null; await db.put('folders', f); } }
  await db.setMeta('dbxCursor', null); await db.setMeta('dbxDeletes', []);
  status = 'local'; lastSync = 0; emit();
}
// 同期を始める前に、編集画面の書きかけを端末に保存させる
let flush = null;
export const setFlush = fn => { flush = fn; };
export const signedIn = () => dbx.signedIn();
export const configured = () => dbx.configured();
