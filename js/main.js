// 起動と、一覧⇔編集の切り替え
import { $, toast } from './ui.js?v=5';
import * as db from './db.js?v=5';
import { openEditor, closeEditor, setLimit, setOnBack, SAMPLE, SAMPLE_CAST } from './editor.js?v=5';
import { initList, renderList, newDoc } from './list.js?v=5';

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
  $('title').textContent = '縦書きセリフ帳';
  renderList();
}

// キーボードが出たら、画面全体を「見えている範囲」に合わせて縮める（仕様書 7：下のバーを持ち上げる）。
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

async function boot() {
  // 端末の空き容量が減ったときにブラウザが勝手に消さないよう頼んでおく
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  // 前回 IndexedDB に入らずに退避した分を戻す
  try { if (await db.restoreStash()) toast('前回保存しきれなかった分を戻しました'); } catch (e) { console.error(e); }
  let [folders, docs, last, limit] = await Promise.all([db.all('folders'), db.all('docs'), db.getMeta('last'), db.getMeta('limit')]);
  if (!folders.length && !docs.length) { // 初回：ネタ帳フォルダにサンプルを1本
    const cast = SAMPLE_CAST.map(c => ({ ...c, aliases: [] }));
    const f = { name: 'ネタ帳', cast, created: Date.now() };
    const d = newDoc('ネタ帳', 'サンプル', SAMPLE, cast);
    await db.put('folders', f); await db.put('docs', d);
    folders = [f]; docs = [d];
  }
  state.folders = folders; state.docs = docs;
  if (limit) setLimit(limit);
  initList(state, showEditor);
  setOnBack(showList);
  const d = last && docs.find(x => x.id === last);
  d ? showEditor(d) : showList();
}
boot().catch(e => { console.error(e); toast('端末の保存領域を開けませんでした'); });

// iOS Safari はページの指定を無視してピンチで拡大することがあるので、拡大の操作そのものを止める
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
