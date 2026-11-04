// 起動と、一覧⇔編集の切り替え
import { $, toast, applyTheme, getTheme } from './ui.js?v=35';
applyTheme(getTheme());
import * as db from './db.js?v=35';
import { openEditor, closeEditor, setOnBack, currentDoc, currentFolder, reloadEditor, flushSave, SAMPLE, SAMPLE_CAST } from './editor.js?v=35';
import { initList, renderList, newDoc } from './list.js?v=35';
import * as sync from './sync.js?v=35';
import { finishSignIn } from './dropbox.js?v=35';
import { setTitle } from './textfile.js?v=35';

const state = { folders: [], docs: [] };

function showEditor(doc) {
  let folder = state.folders.find(f => f.name === doc.folder);
  if (!folder) { folder = { name: doc.folder, cast: [], created: Date.now() }; state.folders.push(folder); }
  document.body.classList.add('in-editor');
  $('listview').hidden = true; $('editview').hidden = false;
  // 編集画面には上のバーを出さない（一覧へ戻るのは下の「‹」）
  document.querySelector('header').hidden = true; $('hdr').innerHTML = '';
  openEditor(doc, folder);
  db.setMeta('last', doc.id);
}
function showList() {
  closeEditor();
  document.body.classList.remove('in-editor');
  $('editview').hidden = true; $('listview').hidden = false;
  document.querySelector('header').hidden = false;
  renderList();
  sync.sync(); // 一覧を開いたときに Dropbox の変更を取り込む
}
const listShown = () => !$('listview').hidden;

// 同期で何か変わったとき：一覧なら描き直す。開いている原稿の中身が差し替わったら開き直す
sync.onChange(ev => {
  if (listShown()) { if (!$('layer').innerHTML) renderList(); return; }
  const cd = currentDoc();
  if (ev.removed && ev.removed === cd) { showList(); toast('このノートは別の端末で消されました'); return; }
  if ((ev.replaced && ev.replaced === cd) || (ev.cast && ev.cast === currentFolder())) reloadEditor();
  if (ev.conflict && ev.replaced === cd) toast(`別の端末の版と食い違ったので、この端末の版を「${ev.conflict.name}」に残しました`);
});

// キーボードが出たら、画面全体を「見えている範囲」に合わせて縮める（仕様書 5-2）。
// iOS はキーボードを出すとき画面ごと押し上げてスクロールさせるので、見えている範囲に貼りつけて追いかける
const vv = window.visualViewport;
if (vv) {
  let lastH = 0, lastKb = null;
  const fit = () => {
    const app = $('app');
    // 画面に出るキーボードが出ているか（物理キーボードやPCでは出ない＝今までどおりの画面）
    const full = Math.max(window.innerHeight, document.documentElement.clientHeight);
    const kb = (vv.scale || 1) < 1.05 && full - vv.height > 150;
    const changed = vv.height !== lastH || kb !== lastKb;
    // 高さが変わる直前に知らせる（編集画面が、見ているセリフの位置を覚えておくため）
    if (changed) window.dispatchEvent(new Event('app-before-resize'));
    document.body.classList.toggle('kb', kb);
    app.style.height = vv.height + 'px';
    app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    if (changed) { lastH = vv.height; lastKb = kb; window.dispatchEvent(new Event('app-resize')); }
  };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}

// 公開版の更新に気づいて読み直す。GitHub Pages は最初のページを10分ほど端末に覚えさせるので、
// 開き直しても古い版が出ることがある。起動時と画面に戻ったときに最新の版番号を確かめ、違えば読み直す
export const APP_V = new URL(import.meta.url).searchParams.get('v') || '';
async function checkUpdate() {
  if (new URL(location.href).searchParams.has('code')) return; // Dropbox のログインから戻ってきたところでは読み直さない
  try {
    const r = await fetch(location.pathname + '?check=' + Date.now(), { cache: 'no-store' });
    const m = (await r.text()).match(/js\/main\.js\?v=(\d+)/);
    if (!m || m[1] === APP_V) return;
    if (sessionStorage.getItem('tategaki-upd') === m[1]) return; // 読み直しても変わらないときに、繰り返さない
    sessionStorage.setItem('tategaki-upd', m[1]);
    flushSave();
    location.replace(location.pathname + '?v=' + m[1]); // アドレスを変えて、覚えている古いページを使わせない
  } catch (e) { /* オフラインなど：今の版のまま使う */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });

async function boot() {
  checkUpdate();
  // 端末の空き容量が減ったときにブラウザが勝手に消さないよう頼んでおく
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  // 前回 IndexedDB に入らずに退避した分を戻す
  try { if (await db.restoreStash()) toast('前回保存しきれなかった分を戻しました'); } catch (e) { console.error(e); }
  let [folders, docs, last] = await Promise.all([db.all('folders'), db.all('docs'), db.getMeta('last')]);
  if (!folders.length && !docs.length) { // 初回：「サンプル」フォルダにサンプルの原稿を1本
    const cast = SAMPLE_CAST.map(c => ({ ...c, aliases: [] }));
    const f = { name: 'サンプル', cast, created: Date.now() };
    const d = newDoc('サンプル', 'サンプル', SAMPLE, cast); d.sample = true; // 一度も触っていないサンプル（Dropbox へは送らない）
    await db.put('folders', f); await db.put('docs', d);
    folders = [f]; docs = [d];
  }
  state.folders = folders; state.docs = docs;
  // Dropbox のログインから戻ってきたところなら、ログインを仕上げる
  let justSignedIn = false;
  try { justSignedIn = await finishSignIn(); if (justSignedIn) toast('Dropbox につなぎました'); } catch (e) { toast(e.message); }
  // ホーム画面のアプリからログインすると、iOS は「アプリ内のブラウザ」の窓の中にこのページを開き直す。
  // その窓は閉じてもらい、元のアプリに戻ってもらう（ログインの結果は元のアプリと共有される）
  if (justSignedIn && justSignedIn.inSheet) { showCloseNotice(); return; }
  await sync.init(state); sync.setFlush(flushSave);
  await tidySamples();
  initList(state, showEditor);
  setOnBack(showList);
  const d = !justSignedIn && last && docs.find(x => x.id === last);
  d ? (showEditor(d), sync.sync()) : showList();
}
// 手つかずのサンプルを見分ける（前の版で作ったサンプルには印がないので、中身で見分ける）。
// また、サンプルどうしの衝突でできてしまった「サンプル（〇〇の版）」のうち、中身が手つかずのサンプルのままのものは片づける
async function tidySamples() {
  const pristine = newDoc('サンプル', 'サンプル', SAMPLE, SAMPLE_CAST).text;
  for (const d of [...state.docs]) {
    if (d.folder !== 'サンプル') continue;
    if (d.name === 'サンプル' && !d.sample && !d.rev && d.text === pristine) { d.sample = true; await db.put('docs', d); }
    else if (/^サンプル（.+の版）$/.test(d.name) && setTitle(d.text, 'サンプル') === pristine) {
      state.docs.splice(state.docs.indexOf(d), 1); await db.del('docs', d.id); await sync.removed(d);
    }
  }
}
function showCloseNotice() {
  document.querySelector('header').hidden = false; $('hdr').innerHTML = '';
  $('listview').hidden = false;
  $('listview').innerHTML = `<div class="notice"><p class="big">✓ Dropbox につなぎました</p>
    <p>この画面は閉じてください。<br>左上の「×」を押すか、画面を下にスワイプすると、元のアプリに戻ります。</p>
    <p>元のアプリに戻ると、自動で同期が始まります。</p></div>`;
}
boot().catch(e => { console.error(e); toast('端末の保存領域を開けませんでした'); });

// 電波がなくても起動できるよう、Service Worker を入れる（公開版だけ。PC の localhost で試すときは入れない：古いファイルが残って紛らわしいため）
if ('serviceWorker' in navigator && isSecureContext && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service Worker を入れられませんでした', e));
}

// iOS Safari はページの指定を無視してピンチで拡大することがあるので、拡大の操作そのものを止める
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
