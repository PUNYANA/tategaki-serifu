// 原稿の編集画面。docs/tategaki-prototype.html の挙動をもとに、実機確認で変えた点を反映したもの（仕様書 5-2）。
// 保存は IndexedDB に .txt 形式で、キャラ表は作品フォルダごと。
import { $, esc, btn, toast, closeLayer, bgClose, spacer, themeButtons } from './ui.js?v=34';
import { parseDoc, parseBody, serializeDoc, docStats, findCast, findSpeaker, newGuest, pickColor, COLORS, splitParas } from './textfile.js?v=34';
import * as db from './db.js?v=34';
import * as sync from './sync.js?v=34';

export const SAMPLE_CAST = [{ id: 'c1', name: '後輩', color: COLORS[1] }, { id: 'c2', name: '先輩', color: COLORS[0] }];
export const SAMPLE = [
  { type: 'div' },
  { type: 'line', who: 'c1', text: '部室の鍵、\nまた開いてる' },
  { type: 'line', who: 'c1', text: '誰か来てるんじゃない？' },
  { type: 'line', who: 'c1', text: 'いや、でもこの時間って\n朝練もないし……' },
  { type: 'line', text: '（ガラッ）' },
  { type: 'div' },
  { type: 'line', who: 'c1', text: '……え、先輩？\n7時ですよ!?' },
  { type: 'line', who: 'c2', text: 'おはよ。\n寝てない' },
  { type: 'line', who: 'c1', text: '寝てないって\n昨日の夜からずっと？' },
  { type: 'line', who: 'c2', text: 'だって明日で最後だし' },
  { type: 'div' },
  { type: 'line', who: 'c1', text: '最後って何がですか' },
  { type: 'line', who: 'c2', text: 'この部室。\n来週から取り壊しの工事が入るんだよ。' },
];

let uid = 1;
const mk = o => ({ id: uid++, type: o.type, text: o.text || '', who: o.who || null });
let st = { items: [], cast: [], guests: [] }; // cast＝レギュラー（作品フォルダのキャラ表）、guests＝この回のゲスト
let cur = null;      // { doc, folder, meta } 開いている原稿
let active = false;  // 編集画面を表示中か
let saveT = 0;
let sel = new Set();
const undo = [], redo = [];
const cv = $('canvas');   // 横にスクロールする箱（横書き）
const sheet = $('sheet'); // その中の縦書きの原稿
const plain = () => ({ items: st.items.map(i => ({ type: i.type, text: i.text, who: i.who })), cast: st.cast, guests: st.guests });
const snap = () => JSON.stringify(plain());
function restore(s) { const o = JSON.parse(s); st.items = o.items.map(mk); st.cast = o.cast; st.guests = o.guests || []; }
function pushUndo(s) { undo.push(s); if (undo.length > 200) undo.shift(); redo.length = 0; }
function commit(fn) { pushUndo(snap()); fn(); save(); }

/* ---- 保存（IndexedDB） ---- */
// 書いている途中の文字も含めて、.txt 形式にして保存する
function save() {
  if (!cur) return; clearTimeout(saveT);
  const ta = $('inl');
  const items = st.items.map(i => editing && ta && i.id === editing.id ? { ...i, text: ta.value } : i);
  cur.folder.cast = st.cast;
  const text = serializeDoc({ title: cur.doc.name, meta: cur.meta, guests: st.guests, items }, st.cast);
  let changed = false;
  if (text !== cur.doc.text) { cur.doc.text = text; cur.doc.updated = Date.now(); cur.doc.stats = docStats(items); cur.doc.dirty = true; cur.doc.sample = false; changed = true; }
  // キャラ表（レギュラー）が変わっていたら、作品フォルダの _cast.json も送る
  const cj = JSON.stringify(st.cast); if (cj !== cur.castJson) { cur.castJson = cj; cur.folder.castDirty = true; changed = true; }
  const doc = cur.doc, folder = cur.folder;
  db.saveDoc(doc, folder).then(() => { if (failed) { failed = false; db.unstash(doc.id); } if (changed) sync.schedule(); }, e => {
    console.error(e); failed = true;
    // IndexedDB がだめでも消さない：退避しておき、次の保存か次の起動で戻す
    toast(db.stash(doc, folder) ? '端末への保存をやり直します（' + (e && e.name || '不明') + '）' : '端末への保存に失敗しました（' + (e && e.name || '不明') + '）');
  });
}
let failed = false;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(save, 400); }
document.addEventListener('visibilitychange', () => {
  if (!active) return;
  if (document.visibilityState === 'hidden') save(); else if (failed) save();
});
window.addEventListener('pagehide', () => { if (active) save(); });

let onBack = null;
export function setOnBack(fn) { onBack = fn; }
// 開いている原稿（同期で中身が差し替わったときに開き直すため）
export const currentDoc = () => (active && cur ? cur.doc : null);
export const currentFolder = () => (active && cur ? cur.folder : null);
// 書きかけの文字を今すぐ端末に保存する（同期の前に呼ぶ）
export function flushSave() { if (active && cur) save(); }
// 同期で原稿の中身が差し替わった：保存せずに（古い中身で上書きしないよう）開き直す
export function reloadEditor() { if (!active || !cur) return; clearTimeout(saveT); const { doc, folder } = cur; const sl = getSL(); openEditor(doc, folder); putSL(sl); lastSl = sl; }
export function openEditor(doc, folder) {
  const p = parseDoc(doc.text, folder.cast);
  cur = { doc, folder, meta: p.meta, castJson: JSON.stringify(folder.cast) };
  st = { items: p.items.map(mk), cast: folder.cast, guests: p.guests };
  sel = new Set(); undo.length = 0; redo.length = 0; editing = null; lock = null; g = null;
  active = true; closeLayer(); closePop();
  allowJumpFor(500); render(); putSL(0); lastSl = 0;
  if (p.added) save();
}
export function closeEditor() {
  if (!active) return;
  if (editing) finishEdit();
  closePop(); closeLayer(); save();
  active = false; cur = null; lock = null; g = null; sel.clear();
  sheet.innerHTML = '';
}

const fmt = s => esc(s).replace(/(^|[^0-9])([0-9]{2})(?![0-9])/g, '$1<span class="tcy">$2</span>').replace(/(!\?|\?!|!!|\?\?)/g, '<span class="tcy">$1</span>');
const idx = id => st.items.findIndex(i => i.id === id);
const who = id => st.guests.find(c => c.id === id) || st.cast.find(c => c.id === id) || null;
function chipBtn(c, on, fn) { const b = btn(c.name, fn, 'chip' + (on ? ' on' : '')); b.style.setProperty('--c', c.color); return b; }

/* ---- 横スクロールの位置 ----
   アプリの中では 0＝書き出し（右端）で、左へ進むほど負として扱う */
// スクロールする箱そのものは横書きにしてある（縦書きの箱をスクロールさせると、iPhone・iPad が位置を何度も 0＝先頭へ書き換えた）。
// 箱の中での位置（scrollLeft）は左端が 0 で右へ増えるので、ここで「書き出し（右端）が 0、左へ進むほど負」に直して使う
const maxSL = () => Math.max(0, cv.scrollWidth - cv.clientWidth);
const getSL = () => cv.scrollLeft - maxSL();
const putSL = v => { cv.scrollLeft = v + maxSL(); };                 // 動かすだけ
const setSL = v => { putSL(v); lastSl = getSL(); }; // アプリが動かした位置は、正しい位置として覚える
// 原稿の幅が変わったとき（列が増えた・減った、字の読み込みなど）、箱の中の位置は左端から数えるので、そのままだと見ている所がずれる。
// 書き出し（右端）から数えた位置を保つよう、覚えている位置へ合わせ直す
let sheetW = 0;
new ResizeObserver(() => {
  const w = sheet.offsetWidth; if (w === sheetW) return; sheetW = w;
  if (active && Math.abs(getSL() - lastSl) > 1) putSL(lastSl);
}).observe(sheet);

/* ---- 描画 ---- */
const leadPage = () => st.items.length && st.items[0].type !== 'div' ? 1 : 0;
function render() {
  // ページ番号：最初の区切りより前にセリフがあればそこが P1、最初の区切りは P2。区切りから始まる原稿なら、その区切りが P1
  let h = '', n = 0, pg = leadPage();
  const slot = at => `<div class="slot" data-at="${at}" role="button" tabindex="0" aria-label="ここにセリフを足す"><span>＋</span></div>`;
  st.items.forEach((it, i) => {
    h += slot(i);
    const c = sel.has(it.id) ? 'sel' : '';
    const grip = '<span class="grip" aria-label="ドラッグして移動"></span>';
    if (it.type === 'div') { pg++; h += `<div class="div ${c}" data-i="${i}">${grip}<span class="lbl">P${pg}</span><span class="pick"><i></i></span></div>`; return; }
    n++; const w = who(it.who); const cs = w ? ` style="--c:${w.color}"` : '';
    const chip = `<span class="who" aria-label="話者を選ぶ"><span${w ? '' : ' hidden'}>${w ? esc(w.name) : ''}</span></span>`;
    if (editing && editing.id === it.id) { h += `<div class="blk editing" data-i="${i}"${cs}>${grip}${chip}<textarea class="inl" id="inl" name="serifu-body" aria-label="セリフ" autocomplete="off" autocorrect="on" spellcheck="false"></textarea></div>`; return; }
    h += `<div class="blk ${c}" data-i="${i}"${cs}>${grip}${chip}${fmt(it.text) || '　'}<span class="pick"><i></i></span></div>`;
  });
  if (!editing) h += slot(st.items.length) + '<div class="newcol" role="button" tabindex="0">ここをタップして書く</div>';
  // 中身を入れ替えても横の位置を保つ
  const sl = getSL();
  sheet.innerHTML = h + '<div class="tail" aria-hidden="true"></div>';
  putSL(sl); lastSl = getSL();
  const ta = $('inl');
  if (ta) { ta.value = st.items[idx(editing.id)].text; fitTa(); }
  posTicks = null; drawPos();
  if (ta) {
    ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', onType); ta.addEventListener('keydown', onKey);
    ta.addEventListener('compositionend', scheduleSave); ta.addEventListener('change', save);
    // 話者の一覧（ゲストの名前を打つ欄）を開いている間は、入力欄からフォーカスが外れても書くのを終えない
    ta.addEventListener('blur', () => setTimeout(() => { if (editing && document.activeElement !== $('inl') && !$('layer').innerHTML && !$('pop')) finishEdit(); }, 150));
  }
  renderBar();
}
// 書いているかどうかを body の印にする（キーボード表示中の「完了」ボタンを出すため）
const markEditing = () => document.body.classList.toggle('editing', !!editing);
$('kbdone').addEventListener('pointerdown', e => e.preventDefault()); // 押しても入力欄からフォーカスを外さない
$('kbdone').addEventListener('click', () => finishEdit());
// 「▲」「▼」：カーソルを前／次の字へ1字ずつ動かす。押し続けると続けて動く
function moveCaret(d) {
  const ta = $('inl'); if (!ta) return;
  const p = d < 0 ? ta.selectionStart : ta.selectionEnd; // 範囲を選んでいたら、その端から動かす
  const q = Math.max(0, Math.min(ta.value.length, p + d)); ta.setSelectionRange(q, q);
}
let caretT = 0;
const stopCaret = () => { clearTimeout(caretT); clearInterval(caretT); caretT = 0; };
[['kbup', -1], ['kbdn', 1]].forEach(([id, d]) => {
  const b = $(id);
  const start = () => { stopCaret(); moveCaret(d); caretT = setTimeout(() => { caretT = setInterval(() => moveCaret(d), 70); }, 380); };
  // iPhone・iPad では pointerdown を止めてもフォーカスが外れる（書くのが終わってキーボードが閉じ、先頭へ飛んでいた）。
  // touchstart を止めるとフォーカスが入力欄に残る
  b.addEventListener('touchstart', e => { e.preventDefault(); start(); }, { passive: false });
  b.addEventListener('touchend', e => { e.preventDefault(); stopCaret(); }, { passive: false });
  b.addEventListener('touchcancel', stopCaret);
  b.addEventListener('pointerdown', e => { e.preventDefault(); if (e.pointerType !== 'touch') start(); }); // マウスのとき
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => b.addEventListener(t, e => { if (e.pointerType !== 'touch') stopCaret(); }));
  b.addEventListener('contextmenu', e => e.preventDefault());
});
// 「横」：書いているセリフを横書きの入力欄で開いて直す（横書きなら iOS のカーソル・選択が普通に使える）。決めると縦書きに戻る
$('kbyoko').addEventListener('pointerdown', e => e.preventDefault());
$('kbyoko').addEventListener('click', () => openYoko());
function openYoko() {
  const ta = $('inl'); if (!editing || !ta) return;
  const pos = ta.selectionStart;
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="横書きで直す"><h2>横書きで直す</h2>
    <textarea id="yk" class="yoko" name="yoko-text" autocomplete="off" aria-label="セリフ（横書き）"></textarea>
    <div class="row"><button type="button" id="yk-no">やめる</button><span class="sp"></span><button type="button" class="pri" id="yk-ok">縦書きに戻す</button></div></div></div>`;
  const y = $('yk'); y.value = ta.value; y.focus(); y.setSelectionRange(pos, pos);
  const back = v => { closeLayer(); const t = $('inl'); if (!t) return; if (v != null) { t.value = v; fitTa(); scheduleSave(); editing.dirty = true; } t.focus({ preventScroll: true }); };
  $('yk-ok').onclick = () => back(y.value);
  $('yk-no').onclick = () => back(null);
}
function paintSel() { cv.querySelectorAll('[data-i]').forEach(el => el.classList.toggle('sel', sel.has(st.items[+el.dataset.i].id))); renderBar(); }
// 下のボタン列。話者は枠の上の名前をタップしてつける（下に話者の列は置かない）
function renderBar() {
  const bar = $('bar'); bar.innerHTML = ''; markEditing();
  if (editing) {
    const els = [btn('横書きで直す', openYoko), spacer(), btn('次のセリフへ', nextSerifu, 'pri'), btn('完了', finishEdit)];
    els.forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));
    bar.append(...els); return;
  }
  if (sel.size) {
    bar.append(btn('話者なし', () => { commit(() => st.items.forEach(i => { if (sel.has(i.id)) i.who = null; })); render(); }), btn('まとめる', doMerge, '', sel.size < 2), btn('削除', doDelete, 'danger'), btn('出力', openMenu), btn('区切り', addDiv), spacer(), btn('解除', () => { sel.clear(); paintSel(); }, 'pri'));
    return;
  }
  // 編集画面には上のバーを置かない。一覧へ・元に戻す／やり直しもこの列にまとめる
  const back = btn('‹', () => onBack && onBack(), 'back'); back.setAttribute('aria-label', '一覧へ戻る');
  bar.append(back, btn('出力・変換', openMenu), btn(st.cast.length ? 'キャラ表' : '＋ キャラ', () => openCast()), spacer(),
    btn('↶', doUndo, 'ur', !undo.length), btn('↷', doRedo, 'ur', !redo.length), btn('＋ 区切り', addDiv, 'pri'));
}

/* ---- 操作 ---- */
function doUndo() { if (!undo.length) return; redo.push(snap()); restore(undo.pop()); sel.clear(); save(); render(); }
function doRedo() { if (!redo.length) return; undo.push(snap()); restore(redo.pop()); sel.clear(); save(); render(); }
function doMerge() {
  const ix = st.items.map((it, i) => sel.has(it.id) ? i : -1).filter(i => i >= 0); const part = ix.map(i => st.items[i]).filter(i => i.type === 'line');
  if (part.length < 2) { toast('セリフを2つ以上選んでください'); return; }
  commit(() => {
    const m = mk({ type: 'line', text: part.map(i => i.text).join('\n'), who: part[0].who });
    st.items = st.items.filter(i => !sel.has(i.id)); st.items.splice(Math.min(ix[0], st.items.length), 0, m); sel = new Set([m.id]);
  });
  render(); toast('1つのセリフにまとめました');
}
function doDelete() { const n = sel.size; commit(() => { st.items = st.items.filter(i => !sel.has(i.id)); }); sel.clear(); render(); toast(`${n}件削除しました（元に戻せます）`); }
// 区切り：セリフを選んでいれば、選んだうち最初のセリフの前（右）に入れる。選んでいなければ最後に入れる
function addDiv() {
  const at = st.items.findIndex(i => sel.has(i.id));
  if (at >= 0) { commit(() => st.items.splice(at, 0, mk({ type: 'div' }))); sel.clear(); render(); toast('選んだセリフの前に区切りを入れました'); return; }
  commit(() => st.items.push(mk({ type: 'div' }))); render(); scrollToI(st.items.length - 1);
}
function scrollToI(i) {
  allowJumpFor(1500); const doc = cur && cur.doc;
  requestAnimationFrame(() => {
    if (!cur || cur.doc !== doc) return; // 実行されるまでに別の原稿へ切り替わっていたら何もしない
    const el = cv.querySelector(`[data-i="${i}"]`); el && el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  });
}
function moveTo(ids, at) {
  commit(() => {
    const mv = st.items.filter(i => ids.has(i.id)); let k = 0; st.items.slice(0, at).forEach(i => { if (!ids.has(i.id)) k++; });
    const rest = st.items.filter(i => !ids.has(i.id)); rest.splice(k, 0, ...mv); st.items = rest;
  });
}
function swapIds(ids, targetId) {
  const ix = st.items.map((it, i) => ids.has(it.id) ? i : -1).filter(i => i >= 0);
  if (ix[ix.length - 1] - ix[0] + 1 !== ix.length) { toast('入れ替えは、続いた範囲だけできます'); return false; }
  let A = { lo: ix[0], hi: ix[ix.length - 1] }, j = idx(targetId), B = { lo: j, hi: j }; if (B.lo < A.lo) [A, B] = [B, A];
  commit(() => { const it = st.items; st.items = [...it.slice(0, A.lo), ...it.slice(B.lo, B.hi + 1), ...it.slice(A.hi + 1, B.lo), ...it.slice(A.lo, A.hi + 1), ...it.slice(B.hi + 1)]; });
  return true;
}

/* ---- その場で書く ---- */
let editing = null;
// キーボードの開閉で画面の高さが変わると、枠の幅が変わってセリフの位置がずれる。
// 変わる直前に、基準のセリフ（書いている枠、なければ画面の真ん中の枠）の右端の位置を覚えておき、変わったあと同じ位置に戻す
let anchor = null;
window.addEventListener('app-before-resize', () => { if (active) anchor = pickAnchor(); });
window.addEventListener('app-resize', () => {
  if (!active) return;
  fitTa();
  if (editing && lock) pin();          // 書いている間は、書いている枠を固定した位置へ
  else if (anchor) {
    const el = cv.querySelector(`[data-i="${anchor.i}"]`);
    if (el) { const c = cv.getBoundingClientRect(); setSL(getSL() + (el.getBoundingClientRect().right - c.right) - anchor.dx); }
  }
  anchor = null;
  keepVisible();
  if (hold && Date.now() < hold.until) hold.v = getSL(); // キーボードが閉じて枠の幅が変わった分は、合わせた位置を新しい基準に
  lastSl = getSL(); // アプリが合わせた位置を正しい位置として覚える
  drawPos();
});
function pickAnchor() {
  const c = cv.getBoundingClientRect();
  const p = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2), el = p && p.closest && p.closest('[data-i]');
  return el ? { i: +el.dataset.i, dx: el.getBoundingClientRect().right - c.right } : null;
}
// 入力欄の大きさを中身に合わせる（試作版と同じ。入力欄は枠の中に置く：仕様書 5-2 の「試してやめた方式」参照）
function fitTa() {
  const ta = $('inl'); if (!ta) return; const blk = ta.parentElement; const cs = getComputedStyle(blk);
  // 枠の上下の余白（通常とキーボード表示中で違う）を引いた分を入力欄の高さにする
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2;
  // 幅を測るため一瞬細くするとスクロール位置が詰められることがあるので、前後で位置を保つ
  const sl = getSL();
  ta.style.height = Math.max(60, blk.clientHeight - pad) + 'px'; ta.style.width = '1.9em'; ta.style.width = Math.max(ta.scrollWidth, 30) + 'px';
  if (Math.abs(getSL() - sl) > .5) putSL(sl);
}
// 書いている枠が画面からはみ出しそうなときだけ動かす。
// 左へはみ出しそう（最後尾で書いていて列が増えたなど）なら、左端に詰めず、画面の左から30%あたりまで寄せて余裕を作る
function keepVisible() {
  const blk = cv.querySelector('.blk.editing'); if (!blk) return;
  const r = blk.getBoundingClientRect(), c = cv.getBoundingClientRect(), m = Math.max(48, c.width * 0.15);
  if (r.left < c.left + m) {
    let d = r.left - (c.left + c.width * 0.3);
    if (r.right - d > c.right - 8) d = r.right - (c.right - 8); // 書き出し（右端）は画面内に残す
    setSL(getSL() + d);
  } else if (r.right > c.right) setSL(getSL() + r.right - c.right);
  lastSl = getSL();
  if (lock) lock.dx = editDx(); // アプリが動かした位置を、新しい固定位置にする
}
// 書いている枠の右端（セリフの書き出し側）が、画面の右端からどれだけ離れているか
function editDx() { const b = cv.querySelector('.blk.editing'); return b ? b.getBoundingClientRect().right - cv.getBoundingClientRect().right : null; }
// 書いている枠を固定した位置へ戻す
function pin() {
  const d = editDx(); if (d == null || !lock) return;
  if (Math.abs(d - lock.dx) > 1) setSL(getSL() + d - lock.dx);
  lastSl = getSL();
}
// 書き始めはキーボードが開く瞬間。iOS が勝手にスクロールしても、タップした枠を画面上のその位置に留める
let lock = null;
function startEdit(id, isNew = false, before) {
  // 書いている途中で別のセリフに移るときは、書いていたほうを先に確定する（しないと書いた分が消える）
  if (editing && editing.id !== id) applyEdit();
  if (before === undefined) before = snap();
  sel.clear(); editing = { id, before, isNew, dirty: false }; lock = null; render();
  lock = { dx: editDx() }; keepVisible();
  requestAnimationFrame(() => { pin(); keepVisible(); });
}
function newAt(at) {
  if (editing) { const e = editing, i = idx(e.id); const last = applyEdit(); if (at > i) at = Math.max(0, at + (last - i)); }
  const before = snap(); const it = mk({ type: 'line' }); st.items.splice(Math.min(at, st.items.length), 0, it); startEdit(it.id, true, before);
}
function onType(e) {
  const ta = e.target;
  if (/\n[ \t]*\n$/.test(ta.value)) { ta.value = ta.value.replace(/\n[ \t]*\n$/, ''); nextSerifu(); return; }
  fitTa(); keepVisible(); scheduleSave();
}
function onKey(e) { // 空のままバックスペースで枠ごと消す
  if (e.key !== 'Backspace' || e.isComposing || e.target.value !== '') return;
  e.preventDefault(); const ed = editing; editing = null; const i = idx(ed.id); if (i < 0) return;
  st.items.splice(i, 1); if (!ed.isNew) pushUndo(ed.before); save();
  let j = i - 1; while (j >= 0 && st.items[j].type !== 'line') j--;
  if (j >= 0) startEdit(st.items[j].id); else render();
}
function applyEdit() {
  const ta = $('inl'); const e = editing; editing = null; const i = idx(e.id); if (i < 0) return -1;
  const it = st.items[i]; const v = ta ? ta.value : it.text; const parts = splitParas(v);
  if (!parts.length) { st.items.splice(i, 1); if (!e.isNew) pushUndo(e.before); save(); return i - 1; }
  if (v !== it.text || e.isNew || e.dirty) { st.items.splice(i, 1, ...parts.map(t => mk({ type: 'line', text: t, who: it.who }))); pushUndo(e.before); save(); }
  return i + parts.length - 1;
}
// 書き終えた直後は、入力欄がなくなったりキーボードが閉じたりして iOS がスクロール位置を勝手に戻すことがある。
// 1.5秒の間は、指で動かしていないのに位置が変わったら、書き終えたときの位置に戻す（セリフを引き寄せたりはしない）
let hold = null;
function finishEdit() { if (!editing) return; applyEdit(); render(); hold = { v: getSL(), until: Date.now() + 1500 }; }
function nextSerifu() { if (!editing) return; const last = applyEdit(); const before = snap(); const it = mk({ type: 'line' }); st.items.splice(last + 1, 0, it); startEdit(it.id, true, before); }

/* ---- キャラ表 ---- */
function openCast() {
  const before = snap();
  const oldNames = new Map(st.cast.map(c => [c.id, c.name]));
  const close = () => {
    st.cast = st.cast.filter(c => c.name.trim());
    st.guests = st.guests.filter(c => c.name.trim());
    // 名前を変えたら古い名前を別名に残す（過去の原稿の話者名と照合するため）
    st.cast.forEach(c => {
      const old = oldNames.get(c.id);
      if (old && old !== c.name) c.aliases = [...new Set([...(c.aliases || []), old])].filter(a => a !== c.name);
    });
    if (snap() !== before) pushUndo(before); save(); closeLayer(); render();
  };
  // 1行＝1キャラ（色の丸・名前・消す）。list はレギュラー（st.cast）かゲスト（st.guests）
  const row = (c, list, box) => {
    const r = document.createElement('div'); r.className = 'cast';
    r.innerHTML = `<button type="button" class="swatch" aria-label="色を変える" style="--c:${c.color}"></button><input type="search" enterkeyhint="done" id="cn-${c.id}" name="chara-${c.id}" value="${esc(c.name)}" placeholder="名前" aria-label="キャラ" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button type="button" class="danger">消す</button>`;
    r.children[0].onclick = () => { c.color = COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length]; save(); draw(); };
    r.children[1].oninput = e => { c.name = e.target.value.replace(/[：:]/g, ''); save(); };
    r.children[2].onclick = () => { list.splice(list.indexOf(c), 1); save(); draw(); };
    box.appendChild(r);
  };
  const draw = () => {
    $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="キャラ表">
      <h2>キャラ表</h2><p>色の丸を押すと色が変わります。消したキャラのセリフは話者なしに戻ります。</p>
      <section><h3>レギュラー（この作品の全部のノート）</h3>
        <div id="cl" class="cast-list"></div>
        <p>レギュラーを足すときは、一覧のフォルダの「…」→「キャラ表」から。</p></section>
      <section><h3>この回のゲスト（このノートだけ）</h3>
        <div id="gl" class="cast-list"></div></section>
      <div class="row"><span class="sp"></span><button type="button" class="pri" id="cl-close">閉じる</button></div></div></div>`;
    const cl = $('cl'), gl = $('gl');
    st.cast.forEach(c => row(c, st.cast, cl));
    st.guests.forEach(c => row(c, st.guests, gl));
    if (!st.cast.length) cl.innerHTML = '<p>まだレギュラーがいません。</p>';
    if (!st.guests.length) gl.innerHTML = '<p>ゲストはいません。セリフの枠の上の名前をタップして「＋ ゲスト」から足せます。</p>';
    $('cl-close').onclick = close; bgClose(close);
  };
  draw();
}

/* ---- 出力・変換 ---- */
let outMode = 'name';
function exportText(withName, items) {
  let pg = items.length && items[0].type !== 'div' ? 1 : 0; // 最初の区切りより前にセリフがあれば、最初の区切りは P2
  return items.map(i => { if (i.type === 'div') { pg++; return '--- P' + pg; } const w = who(i.who); return withName && w ? `${w.name}：${i.text}` : i.text; }).join('\n\n');
}
const importText = t => parseBody(t, st.cast, st.guests).map(mk); // 知らない名前はこの回のゲストになる
function punct(t, o) { if (o.maru) t = t.replace(/[。｡]/g, ''); if (o.ten) t = t.replace(/[、､]/g, o.half ? ' ' : '　'); return t.replace(/[ 　]+$/gm, ''); }
function openMenu() {
  if (editing) finishEdit();
  const scopeSel = sel.size > 0;
  const scoped = () => scopeSel ? st.items.filter(i => sel.has(i.id)) : st.items;
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="出力・変換">
    <div class="row"><h2>出力・変換</h2><span class="sp"></span><span class="scope">${scopeSel ? `選択中の${sel.size}件が対象` : '全体が対象'}</span></div>
    <section><h3>書き出し</h3>
      <div class="seg" role="group" aria-label="書き出し形式"><button type="button" id="o-name">名前：セリフ</button><button type="button" id="o-raw">入力したまま</button></div>
      <textarea id="o-ta" readonly aria-label="書き出し結果"></textarea>
      <div class="row"><button type="button" class="pri" id="o-copy">コピー</button></div></section>
    <section><h3>句読点の一括変換</h3>
      <label class="ck"><input type="checkbox" id="p-maru" checked>「。」を消す</label>
      <label class="ck"><input type="checkbox" id="p-ten" checked>「、」をスペースにする</label>
      <label class="ck"><input type="checkbox" id="p-half">スペースを半角にする（ふだんは全角）</label>
      <div class="row"><button type="button" id="p-go">変換する</button></div><p>行末に残ったスペースは消します。元に戻せます。</p></section>
    <section><h3>読み込み</h3>
      <textarea id="i-ta" name="import-text" autocomplete="off" placeholder="ここに貼り付け。セリフは空行で区切る。「名前：」で始まると話者がつく。「---」はページの区切り。" aria-label="読み込むテキスト"></textarea>
      <div class="row"><button type="button" id="i-add">最後に足す</button><button type="button" id="i-rep" class="danger">全部置き換え</button></div></section>
    <section><h3>設定</h3>
      <div class="row"><span class="lbl-t">色</span><span id="mn-theme"></span></div>
      <div class="row"><button type="button" id="mn-sample" class="danger">サンプルに戻す</button><span class="sp"></span><button type="button" class="pri" id="mn-close">閉じる</button></div></section>
  </div></div>`;
  themeButtons($('mn-theme'));
  const ta = $('o-ta');
  const draw = () => { ta.value = exportText(outMode === 'name', scoped()); $('o-name').className = outMode === 'name' ? 'on' : ''; $('o-raw').className = outMode === 'raw' ? 'on' : ''; };
  $('o-name').onclick = () => { outMode = 'name'; draw(); }; $('o-raw').onclick = () => { outMode = 'raw'; draw(); }; draw();
  $('o-copy').onclick = () => {
    const ok = () => toast('コピーしました'), ng = () => { ta.focus(); ta.select(); toast('選択しました。コピーしてください'); };
    // http（同じWi-Fiから開いたとき）では clipboard が使えないので、試作版と同じく選択に切り替える
    navigator.clipboard ? navigator.clipboard.writeText(ta.value).then(ok, ng) : ng();
  };
  $('p-go').onclick = () => {
    const o = { maru: $('p-maru').checked, ten: $('p-ten').checked, half: $('p-half').checked }; let n = 0;
    commit(() => scoped().forEach(i => { if (i.type !== 'line') return; const t = punct(i.text, o); if (t !== i.text) { i.text = t; n++; } })); draw(); render(); toast(n + '件を変換しました');
  };
  $('i-add').onclick = () => { const v = $('i-ta').value; if (!v.trim()) return; commit(() => { st.items.push(...importText(v)); }); closeLayer(); render(); scrollToI(st.items.length - 1); toast('足しました'); };
  $('i-rep').onclick = () => { const v = $('i-ta').value; if (!v.trim()) return; commit(() => { st.items = importText(v); }); sel.clear(); closeLayer(); render(); toast('置き換えました（元に戻せます）'); };
  // サンプルに戻す：この原稿の中身をサンプルに置き換える。キャラ表は作品で共有なので、足りないキャラだけ足す
  $('mn-sample').onclick = () => {
    commit(() => {
      const map = {};
      SAMPLE_CAST.forEach(sc => { let c = findCast(st.cast, sc.name); if (!c) { c = { ...sc, id: 'c' + Date.now().toString(36) + st.cast.length, aliases: [] }; st.cast.push(c); } map[sc.id] = c.id; });
      st.items = SAMPLE.map(o => mk({ ...o, who: o.who ? map[o.who] : null }));
    });
    sel.clear(); closeLayer(); render();
  };
  $('mn-close').onclick = () => { closeLayer(); render(); };
  bgClose(() => { closeLayer(); render(); });
}

/* ---- その場の話者ポップアップ ---- */
function closePop() {
  const o = $('pop'); if (!o) return; o.remove();
  // ゲストの名前を打ったまま閉じたときは、書いている入力欄にフォーカスが戻らない。戻っていなければ書くのを終える
  setTimeout(() => { if (editing && document.activeElement !== $('inl') && !$('pop') && !$('layer').innerHTML) finishEdit(); }, 150);
}
// 一覧の並び：レギュラー → 仕切り → この回のゲスト → 「＋ ゲスト」 → 「なし」
function openPop(id) {
  closePop();
  if (editing && editing.id !== id) finishEdit();
  let it = st.items[idx(id)]; if (!it) return;
  const anchor = cv.querySelector(`[data-i="${idx(id)}"] .who`); if (!anchor) return;
  const ids = sel.has(id) ? [...sel] : [id];
  const o = document.createElement('div'); o.id = 'pop'; o.setAttribute('role', 'menu');
  // w：話者のid（なしは null）。g：新しく足すゲスト（あれば一緒に足す。元に戻すと一緒に消える）
  const set = (w, g) => {
    closePop();
    if (editing && editing.id === id) {
      if (g) st.guests.push(g);
      it.who = w; editing.dirty = true; const ta = $('inl'); const v = ta ? ta.value : ''; render(); const t2 = $('inl'); if (t2) { t2.value = v; fitTa(); } scheduleSave(); return;
    }
    commit(() => { if (g) st.guests.push(g); ids.forEach(k => { const x = st.items[idx(k)]; if (x && x.type === 'line') x.who = w; }); }); render();
  };
  const place = () => {
    const r = anchor.getBoundingClientRect(), w = o.offsetWidth;
    o.style.top = (r.bottom + 4) + 'px'; o.style.left = Math.max(16, Math.min(window.innerWidth - 16 - w, r.left + r.width / 2 - w / 2)) + 'px';
  };
  const keepFocus = () => o.querySelectorAll('button').forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));
  const list = () => {
    o.innerHTML = '';
    st.cast.forEach(c => o.appendChild(chipBtn(c, it.who === c.id, () => set(c.id))));
    if (st.cast.length && st.guests.length) { const s = document.createElement('span'); s.className = 'pop-sep'; s.setAttribute('aria-hidden', 'true'); o.appendChild(s); }
    st.guests.forEach(c => { const b = chipBtn(c, it.who === c.id, () => set(c.id)); b.classList.add('guest'); o.appendChild(b); });
    o.appendChild(btn('＋ ゲスト', ask, 'chip add'));
    o.appendChild(btn('なし', () => set(null), 'chip none'));
    keepFocus(); place();
  };
  // 「＋ ゲスト」：その場で名前を打って、この回のゲストとして足す。同じ名前の人がいれば、その人を選ぶ
  const ask = () => {
    o.innerHTML = `<input type="search" enterkeyhint="done" id="pop-g" name="guest-name" placeholder="ゲストの名前" aria-label="ゲストの名前" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`
      + `<button type="button" class="pri" id="pop-ok">足す</button><button type="button" id="pop-back">戻る</button>`;
    const inp = $('pop-g');
    const ok = () => {
      const name = inp.value.trim().replace(/[：:]/g, ''); if (!name) { inp.focus(); return; }
      const c = findSpeaker(name, st.cast, st.guests);
      if (c) set(c.id); else { const g = newGuest(name, st.cast, st.guests); set(g.id, g); }
    };
    $('pop-ok').onclick = ok; $('pop-back').onclick = list;
    inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok(); } };
    $('pop-ok').addEventListener('pointerdown', e => e.preventDefault()); $('pop-back').addEventListener('pointerdown', e => e.preventDefault());
    place(); inp.focus();
  };
  document.body.appendChild(o);
  list();
}
document.addEventListener('pointerdown', e => { if ($('pop') && !e.target.closest('#pop,.who')) closePop(); }, true);
cv.addEventListener('scroll', () => { if (!$('pop-g')) closePop(); }); // ゲストの名前を打っている間は閉じない

/* ---- 上の細い位置表示 ----
   線全体＝原稿全体（右が書き出し）。濃い部分＝いま画面に見えている範囲。目盛り＝ページの区切り。右に今のページ番号 */
let posTicks = null, posRaf = 0;
// 上の線をタップするとそこへ飛ぶ。なぞると原稿の中をすばやく移動できる（線の右端が書き出し）
let posDrag = false;
function posJump(x) {
  const tr = $('pos').querySelector('.track').getBoundingClientRect(); if (!tr.width) return;
  const ratio = Math.min(1, Math.max(0, (tr.right - x) / tr.width));
  allowJumpFor(400); setSL(-(ratio * cv.scrollWidth - cv.clientWidth / 2)); lastSl = getSL();
  if (lock) lock.dx = editDx();
  drawPos();
}
$('pos').addEventListener('pointerdown', e => { if (!active) return; e.preventDefault(); posDrag = true; try { $('pos').setPointerCapture(e.pointerId); } catch (_) { } posJump(e.clientX); });
$('pos').addEventListener('pointermove', e => { if (posDrag) posJump(e.clientX); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => $('pos').addEventListener(t, () => { posDrag = false; }));
sync.onChange(() => { if (active) drawSync(); });
function drawPos() {
  if (posRaf) return;
  posRaf = requestAnimationFrame(() => { posRaf = 0; drawPosNow(); });
  setTimeout(() => { if (posRaf) { cancelAnimationFrame(posRaf); posRaf = 0; drawPosNow(); } }, 120); // 画面が裏のときの保険
}
function drawPosNow() {
  const box = $('pos'); if (!box || !active) return;
  const W = cv.scrollWidth, V = cv.clientWidth, from = -getSL(); // from：書き出し（右端）から見ている位置までの距離
  const c = cv.getBoundingClientRect(), right = c.right + from;         // 原稿の右端の画面上の位置
  if (!posTicks) {
    posTicks = [...cv.querySelectorAll('.div')].map(el => right - el.getBoundingClientRect().right);
    box.querySelector('.track').innerHTML = '<i class="thumb"></i>' + posTicks.map(d => `<b style="right:${(d / W * 100).toFixed(2)}%"></b>`).join('');
  }
  const th = box.querySelector('.thumb');
  th.style.right = (from / W * 100).toFixed(2) + '%'; th.style.width = Math.max(2, V / W * 100).toFixed(2) + '%';
  const mid = from + V / 2, n = posTicks.filter(d => d <= mid).length;
  const lead = leadPage(), total = posTicks.length + lead; // 最初の区切りより前にセリフがあれば、そこが P1
  box.querySelector('.pg').textContent = posTicks.length ? `P${Math.max(1, n + lead)} / ${total}` : '';
  drawSync();
}
// 同期の状態（上の線の右端、ページ番号の横）。Dropbox にログインしていなければ出さない
const SYNC_LABEL = { synced: '保存済み', pending: '送信待ち', busy: '送信中', offline: 'オフライン・端末に保存済み', conflict: '衝突あり', error: '送信できません' };
function drawSync() {
  const el = $('pos') && $('pos').querySelector('.sync'); if (!el || !cur) return;
  const s = sync.docState(cur.doc);
  const k = !s ? '' : s === 'conflict' ? 'conflict' : sync.status === 'offline' ? 'offline' : sync.status === 'error' ? 'error' : sync.status === 'busy' && s === 'pending' ? 'busy' : s;
  el.textContent = k ? SYNC_LABEL[k] : ''; el.className = 'sync ' + k; el.title = k === 'error' ? sync.lastError : '';
}

/* ---- 勝手なスクロールを防ぐ ----
   iOS は入力中のカーソルを見せようとして自分でスクロールするが、縦書きではこれを間違えて先頭へ飛ばしたり、端へ詰めたりする。
   「人が動かしている」とみなすのは、指が実際に横へ動いたとき（とその後の惰性）、マウスで押している間、ホイールのときだけ。
   ・書いている間：それ以外のスクロールは全部戻し、書いている枠を画面上の同じ位置に留める
   ・書いていない間：一度に大きく飛んだときだけ戻す */
let lastSl = 0, fingerDown = false, fingerMoved = false, mouseDown = false, userUntil = 0;
let coasting = false, coastT = 0;          // 指を離したあとの惰性スクロール中か（スクロールが0.15秒途切れたら終わり）
let reverts = [];                          // 直近で「戻した」時刻（iOS と引っ張り合っていないかの見張り）
function allowJumpFor(ms) { userUntil = Math.max(userUntil, Date.now() + ms); }
const userScrolling = () => (fingerDown && fingerMoved) || coasting || mouseDown || Date.now() < userUntil;
cv.addEventListener('touchstart', () => { fingerDown = true; fingerMoved = false; coasting = false; }, { passive: true });
// つまみでの移動・丸でなぞる選択の間は、指が動いても原稿はスクロールしないので「人のスクロール」にしない
cv.addEventListener('touchmove', () => { if (fingerDown && !(g && (g.kind === 'drag' || g.kind === 'pick'))) fingerMoved = true; }, { passive: true });
const fingerUp = () => {
  // 指でスクロールしていたなら、惰性が止まるまでは人の操作として扱う（時間では区切らない）
  if (fingerMoved) { coasting = true; clearTimeout(coastT); coastT = setTimeout(() => { coasting = false; }, 150); }
  fingerDown = false; fingerMoved = false;
};
cv.addEventListener('touchend', fingerUp, { passive: true });
cv.addEventListener('touchcancel', fingerUp, { passive: true });
cv.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') mouseDown = true; }, true);
window.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') mouseDown = false; }, true);
cv.addEventListener('wheel', () => allowJumpFor(400), { passive: true });
cv.addEventListener('scroll', () => {
  if (!active) return;
  if (coasting) { clearTimeout(coastT); coastT = setTimeout(() => { coasting = false; }, 150); } // 惰性が続いている
  const sl = getSL();
  if (editing && lock) {
    if (userScrolling()) lock.dx = editDx();   // 人が動かした → その位置を新しい固定位置に
    else if (Math.abs(editDx() - lock.dx) > 1) {
      // 勝手に動いた → 戻す。ただし短い間に何度も戻す羽目になったら（iOS と引っ張り合って震える）、戻すのをやめて今の位置を受け入れる
      const now = Date.now(); reverts = reverts.filter(t => now - t < 600);
      if (reverts.length >= 3) { lock.dx = editDx(); reverts = []; }
      else { reverts.push(now); pin(); return; }
    }
  } else if (hold && Date.now() < hold.until && !userScrolling() && Math.abs(sl - hold.v) > 2) {
    putSL(hold.v); return; // 書き終えた直後の勝手な移動は戻す
  } else if (!userScrolling() && Math.abs(sl - lastSl) > 2) { // 人もアプリも動かしていないのに動いた → どれだけ小さくても戻す
    putSL(lastSl); return;
  }
  lastSl = sl;
  drawPos();
});

/* ---- 指の操作 ---- */
let g = null;
const pt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el : null; };
function autoScroll(x, y) { if (Math.hypot(x - g.x0, y - g.y0) < 30) return; const rc = cv.getBoundingClientRect(); if (x < rc.left + 32) setSL(getSL() - 14); else if (x > rc.right - 32) setSL(getSL() + 14); }
// マウスのホイール（縦回し）でも横にスクロールする
cv.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { setSL(getSL() - e.deltaY); e.preventDefault(); } }, { passive: false });
cv.addEventListener('pointerdown', e => {
  if (e.target.closest('textarea')) return;
  if (!e.target.closest('[data-i],.slot,.newcol') && e.pointerType !== 'touch') { g = { kind: 'pan', x: e.clientX, y: e.clientY, sl: getSL(), mouse: true, moving: true }; return; }
  const s = e.target.closest('.slot,.newcol');
  if (s) { g = { kind: 'tapslot', at: s.classList.contains('newcol') ? st.items.length : +s.dataset.at, x: e.clientX, y: e.clientY, sl: getSL() }; return; }
  const el = e.target.closest('[data-i]'); if (!el) return;
  const i = +el.dataset.i; const id = st.items[i].id;
  if (e.target.closest('.pick')) { e.preventDefault(); if (editing) finishEdit(); const on = !sel.has(id); g = { kind: 'pick', from: i, on, base: new Set(sel), x0: e.clientX, y0: e.clientY }; applyPick(i); return; }
  if (e.target.closest('.grip')) { e.preventDefault(); if (editing) finishEdit(); const ids = sel.has(id) ? new Set(sel) : new Set([id]); g = { kind: 'drag', ids, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, started: false }; return; }
  if (e.target.closest('.who') && st.items[i].type === 'line') {
    // 書いている枠の名前を押したときは、入力欄からフォーカスを外さない（キーボードを閉じない）
    if (editing && editing.id === id) e.preventDefault();
    g = { kind: 'who', id, x: e.clientX, y: e.clientY, sl: getSL() }; return;
  }
  if (editing && editing.id === id) return;
  g = { kind: 'tap', i, x: e.clientX, y: e.clientY, mouse: e.pointerType !== 'touch', sl: getSL() };
});
function applyPick(j) {
  const lo = Math.min(g.from, j), hi = Math.max(g.from, j); sel = new Set(g.base);
  for (let k = lo; k <= hi; k++) { const id = st.items[k].id; g.on ? sel.add(id) : sel.delete(id); } paintSel();
}
function startDrag() {
  g.started = true; const first = st.items.find(i => g.ids.has(i.id));
  const gh = document.createElement('div'); gh.id = 'ghost';
  gh.innerHTML = `<span>${esc(first.type === 'div' ? '区切り' : (first.text || '').split('\n')[0].slice(0, 8))}</span>${g.ids.size > 1 ? `<b>${g.ids.size}</b>` : ''}`; document.body.appendChild(gh);
  cv.querySelectorAll('[data-i]').forEach(el => { if (g.ids.has(st.items[+el.dataset.i].id)) el.classList.add('lift'); });
}
function clearDrop() { cv.querySelectorAll('.drop-before,.drop-after,.drop-swap,.drop-at').forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-swap', 'drop-at')); }
window.addEventListener('pointermove', e => {
  if (!g) return;
  if (g.kind === 'tap' && g.mouse && Math.abs(e.clientX - g.x) > 8) { g.kind = 'pan'; g.moving = true; cv.classList.add('panning'); }
  if (g.kind === 'pan') { if (g.moving) setSL(g.sl - (e.clientX - g.x)); return; }
  if (g.kind === 'tap' || g.kind === 'tapslot' || g.kind === 'who') { if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) g = null; return; }
  autoScroll(e.clientX, e.clientY);
  const el = pt(e.clientX, e.clientY);
  if (g.kind === 'pick') { const b = el && el.closest('[data-i]'); if (b) applyPick(+b.dataset.i); return; }
  if (!g.started) { if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return; startDrag(); }
  const gh = $('ghost'); gh.style.left = e.clientX + 'px'; gh.style.top = e.clientY + 'px';
  clearDrop(); g.drop = null; if (!el) return;
  const s = el.closest('.slot'); if (s) { g.drop = { kind: 'at', at: +s.dataset.at }; s.classList.add('drop-at'); return; }
  const b = el.closest('[data-i]'); if (!b) return;
  const i = +b.dataset.i, it = st.items[i]; if (g.ids.has(it.id)) return;
  const rc = b.getBoundingClientRect(), f = (e.clientX - rc.left) / rc.width;
  const kind = it.type === 'div' ? (f > .5 ? 'before' : 'after') : (f > .68 ? 'before' : f < .32 ? 'after' : 'swap');
  g.drop = kind === 'swap' ? { kind, id: it.id } : { kind: 'at', at: kind === 'before' ? i : i + 1 }; b.classList.add('drop-' + kind);
});
// iOS は pointerdown を止めてもフォーカスが移ることがあるので touchstart でも止める（pointerup は届くのでポップアップは開く）
cv.addEventListener('touchstart', e => { if (editing && e.target.closest('.blk.editing .who')) e.preventDefault(); }, { passive: false });
cv.addEventListener('touchmove', e => { if (g && (g.kind === 'pick' || g.kind === 'drag')) e.preventDefault(); }, { passive: false });
function end(cancel) {
  if (!g) return; const p = g; g = null;
  // 押したまま横にスクロールしたあとで指を離したのは、タップではない（＋やセリフが反応しないように）
  if ((p.kind === 'tap' || p.kind === 'tapslot' || p.kind === 'who') && Math.abs(getSL() - p.sl) > 4) cancel = true;
  if (p.kind === 'who') { if (!cancel) openPop(p.id); return; }
  if (p.kind === 'pan') { cv.classList.remove('panning'); return; }
  if (p.kind === 'tap') {
    if (cancel) return; const it = st.items[p.i]; if (!it) return;
    if (it.type === 'line') startEdit(it.id); else if (editing) finishEdit(); return;
  }
  if (p.kind === 'tapslot') { if (!cancel) newAt(p.at); return; }
  if (p.kind === 'pick') return;
  const gh = $('ghost'); gh && gh.remove(); clearDrop();
  if (!p.started || cancel || !p.drop) { render(); return; }
  if (p.drop.kind === 'swap') { if (swapIds(p.ids, p.drop.id)) toast('入れ替えました'); }
  else { moveTo(p.ids, p.drop.at); toast('移動しました'); }
  render();
}
window.addEventListener('pointerup', () => end(false));
window.addEventListener('pointercancel', () => end(true));
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return; const s = e.target.closest('.slot,.newcol');
  if (s) { e.preventDefault(); newAt(s.classList.contains('newcol') ? st.items.length : +s.dataset.at); }
});
document.addEventListener('keydown', e => {
  if (!active || $('layer').innerHTML || editing) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  if (e.key === 'Escape') { sel.clear(); paintSel(); }
});
