// 原稿一覧：作品フォルダごとに原稿を並べる（更新順）
import { $, esc, btn, toast, closeLayer, bgClose } from './ui.js?v=11';
import { serializeDoc, docStats, setTitle } from './textfile.js?v=11';
import * as db from './db.js?v=11';
import * as sync from './sync.js?v=11';

let S = null, onOpen = null;
export const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export function newDoc(folder, name, items = [], cast = []) {
  return { id: genId(), folder, name, text: serializeDoc({ title: name, meta: [], items }, cast), updated: Date.now(), stats: docStats(items) };
}

const p2 = x => String(x).padStart(2, '0');
function fmtDate(t) {
  const d = new Date(t), md = `${d.getMonth() + 1}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

// Dropboxのファイル名に使えない文字・一覧に出なくなる名前を弾く。大文字小文字は同じ名前として扱う
function badName(v) {
  if (!v) return '名前を入れてください';
  if (/[\\/:*?"<>|]/.test(v)) return '次の文字は使えません：\\ / : * ? " < > |';
  if (/^[_.]/.test(v)) return '「_」か「.」で始まる名前は使えません';
  if (v.length > 80) return '名前が長すぎます';
  return '';
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const docCheck = (folder, self) => v => badName(v) || (S.docs.some(d => d.folder === folder && d !== self && same(d.name, v)) ? '同じフォルダに同じ名前の原稿があります' : '');
function uniqueName(folder, base) {
  const taken = v => S.docs.some(d => d.folder === folder && same(d.name, v));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
}

export function initList(state, open) {
  S = state; onOpen = open;
  $('listview').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.new != null) newDocSheet(b.dataset.new);
    else if (b.dataset.open) { const d = S.docs.find(x => x.id === b.dataset.open); d && onOpen(d); }
    else if (b.dataset.more) { const d = S.docs.find(x => x.id === b.dataset.more); d && docMenu(d); }
  });
}

// 同期の印。文字の説明だけでなく形でも区別する（仕様書 5-1）
const MARK = { synced: ['✓', '同期済み'], pending: ['↑', '未送信あり'], conflict: ['⚠', '衝突あり'] };
const mark = d => { const s = sync.docState(d); return s ? `<span class="sm ${s}" title="${MARK[s][1]}" aria-label="${MARK[s][1]}">${MARK[s][0]}</span>` : ''; };
// 右上の Dropbox ボタンに出す、全体の同期の状態
const STATUS = { idle: ['✓', '同期済み'], busy: ['↻', '送信中'], offline: ['⦸', 'オフライン・端末に保存済み'], error: ['!', '送信できません'], local: ['', 'つないでいません'] };

export function renderList() {
  const hdr = $('hdr'); hdr.innerHTML = '';
  const st = sync.signedIn() ? (S.docs.some(d => sync.docState(d) === 'conflict') && sync.status === 'idle' ? ['⚠', '衝突あり'] : STATUS[sync.status]) : STATUS.local;
  const db_ = btn(`${st[0] ? st[0] + ' ' : ''}Dropbox`, dbxSheet, 'dbx ' + sync.status); db_.setAttribute('aria-label', 'Dropbox：' + st[1]);
  hdr.append(db_, btn('＋ フォルダ', newFolder));
  const folders = [...S.folders].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  $('listview').innerHTML = folders.map(f => {
    const docs = S.docs.filter(d => d.folder === f.name).sort((a, b) => b.updated - a.updated);
    const rows = docs.map(d => `<li class="doc"><button type="button" class="open" data-open="${d.id}"><span class="dn">${mark(d)}${esc(d.name)}</span>`
      + `<span class="dm">${fmtDate(d.updated)}　セリフ ${d.stats.lines}　${d.stats.chars}字</span></button>`
      + `<button type="button" class="more" data-more="${d.id}" aria-label="${esc(d.name)}の操作">…</button></li>`).join('');
    return `<section class="fold"><div class="fh"><h2>${esc(f.name)}</h2><span class="sp"></span><button type="button" data-new="${esc(f.name)}">＋ 原稿</button></div>`
      + (docs.length ? `<ul class="docs">${rows}</ul>` : '<p class="empty">まだ原稿がありません</p>') + '</section>';
  }).join('') || '<p class="empty">右上の「＋ フォルダ」から作品フォルダを作ってください</p>';
}

/* ---- 名前を打つシート ---- */
function nameSheet({ title, value, ok, check, done }) {
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2>
    <input type="text" id="nm" name="sheet-text" value="${esc(value)}" aria-label="${esc(title)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"><p class="err" id="nm-err"></p>
    <div class="row"><span class="sp"></span><button type="button" id="nm-cancel">やめる</button><button type="button" class="pri" id="nm-ok">${esc(ok)}</button></div></div></div>`;
  const inp = $('nm');
  const go = () => { const v = inp.value.trim(); const e = check(v); if (e) { $('nm-err').textContent = e; return; } closeLayer(); done(v); };
  $('nm-ok').onclick = go;
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } };
  $('nm-cancel').onclick = closeLayer; bgClose(closeLayer);
  inp.focus(); inp.select();
}

function newDocSheet(folder) {
  nameSheet({
    title: `「${folder}」に原稿を作る`, value: uniqueName(folder, '無題'), ok: '作る', check: docCheck(folder, null),
    done: async v => { const d = newDoc(folder, v); S.docs.push(d); await db.put('docs', d); sync.schedule(); onOpen(d); },
  });
}
function newFolder() {
  nameSheet({
    title: 'フォルダを作る', value: '', ok: '作る',
    check: v => badName(v) || (S.folders.some(f => same(f.name, v)) ? '同じ名前のフォルダがあります' : ''),
    done: async v => { const f = { name: v, cast: [], created: Date.now() }; S.folders.push(f); await db.put('folders', f); sync.schedule(); renderList(); toast('フォルダを作りました'); },
  });
}

/* ---- 原稿ごとの操作（名前変更・複製・削除） ---- */
function docMenu(d, confirming = false) {
  if (confirming) {
    $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="削除の確認">
      <h2>「${esc(d.name)}」を削除しますか？</h2><p>この端末から消えます。元に戻せません。</p>
      <div class="row"><span class="sp"></span><button type="button" id="dm-no">やめる</button><button type="button" class="danger" id="dm-yes">削除する</button></div></div></div>`;
    $('dm-no').onclick = () => docMenu(d);
    $('dm-yes').onclick = async () => {
      S.docs.splice(S.docs.indexOf(d), 1); await db.del('docs', d.id); await sync.removed(d);
      if ((await db.getMeta('last')) === d.id) await db.setMeta('last', null);
      closeLayer(); renderList(); toast('削除しました');
    };
    bgClose(closeLayer); return;
  }
  // 衝突しているときは、どちらの版を残すかを選べる（残さないほうは消える。Dropbox のゴミ箱からは戻せる）
  const pair = sync.partners(d);
  const clash = pair.length ? `<section class="clash"><h3>⚠ 衝突しています</h3>
      <p>${sync.isCopy(d) ? `「${esc(pair[0].name)}」（Dropbox の版）と` : `${pair.map(x => `「${esc(x.name)}」`).join('、')}と`}食い違っています。見比べて、残すほうを選んでください。</p>
      <div class="row"><button type="button" class="pri" id="dm-keep">この版を残す</button></div>
      <p>${sync.isCopy(d) ? 'この版の中身を、元の名前の原稿に移します。' : '別の版を消します。'}</p></section>` : '';
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="原稿の操作">
    <h2>${esc(d.name)}</h2><p>${esc(d.folder)}　${fmtDate(d.updated)}　セリフ ${d.stats.lines}　${d.stats.chars}字</p>${clash}
    <section><h3>名前を変える</h3><div class="row"><input type="text" id="dm-name" name="doc-title" value="${esc(d.name)}" aria-label="原稿のタイトル" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="flex:1" enterkeyhint="done"><button type="button" id="dm-ren">変更</button></div><p class="err" id="dm-err"></p></section>
    <section><div class="row"><button type="button" id="dm-dup">複製</button><button type="button" class="danger" id="dm-del">削除</button><span class="sp"></span><button type="button" class="pri" id="dm-close">閉じる</button></div></section>
  </div></div>`;
  const rename = async () => {
    const v = $('dm-name').value.trim(); if (v === d.name) { closeLayer(); return; }
    const e = docCheck(d.folder, d)(v); if (e) { $('dm-err').textContent = e; return; }
    d.name = v; d.text = setTitle(d.text, v); d.updated = Date.now(); d.dirty = true; await db.put('docs', d); sync.schedule();
    closeLayer(); renderList(); toast('名前を変えました');
  };
  if (pair.length) $('dm-keep').onclick = async () => { const k = await sync.resolve(d); closeLayer(); renderList(); toast(`「${k.name}」の1本にしました`); };
  $('dm-ren').onclick = rename;
  $('dm-name').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); rename(); } };
  $('dm-dup').onclick = async () => {
    const name = uniqueName(d.folder, d.name + 'のコピー');
    const c = { id: genId(), folder: d.folder, name, text: setTitle(d.text, name), updated: Date.now(), stats: { ...d.stats } }; // 同期の情報（path・rev）は引き継がない
    S.docs.push(c); await db.put('docs', c); sync.schedule(); closeLayer(); renderList(); toast('複製しました');
  };
  $('dm-del').onclick = () => docMenu(d, true);
  $('dm-close').onclick = closeLayer; bgClose(closeLayer);
}

/* ---- Dropbox（右上のボタン） ---- */
function dbxSheet() {
  const when = t => t ? fmtDate(t) : 'まだ';
  let body;
  if (!sync.configured()) {
    body = `<p>Dropbox の App key がまだ設定されていません（js/config.js）。</p>`;
  } else if (!sync.signedIn()) {
    body = `<p>つなぐと、原稿を Dropbox の「アプリ」フォルダの中にある、このアプリ専用のフォルダ（Dropbox に登録したアプリの名前のフォルダ）に普通のテキストファイルとして保存し、ほかの端末と同期します。このアプリが触れるのは、そのフォルダの中だけです。つながなくても、この端末の中だけで使えます。</p>
      <div class="row"><button type="button" class="pri" id="dx-in">Dropbox につなぐ</button></div>`;
  } else {
    const label = { idle: '同期済み', busy: '送信中', offline: 'オフライン・端末に保存済み', error: '送信できません', local: '' }[sync.status] || '';
    const n = S.docs.filter(d => sync.docState(d) === 'conflict').length;
    body = `<p>状態：<b>${label}</b>　最後に同期：${when(sync.lastSync)}</p>`
      + (sync.status === 'error' && sync.lastError ? `<p class="err">${esc(sync.lastError)}</p>` : '')
      + (n ? `<p class="err">⚠ 衝突している原稿があります（${n}本）。一覧の「…」から、残す版を選んでください。</p>` : '')
      + `<div class="row"><button type="button" class="pri" id="dx-now">今すぐ同期</button><span class="sp"></span><button type="button" id="dx-out">ログアウト</button></div>
      <p>ログアウトしても、この端末の原稿は消えません。</p>`;
  }
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="Dropbox"><h2>Dropbox</h2>${body}
    <div class="row"><span class="sp"></span><button type="button" id="dx-close">閉じる</button></div></div></div>`;
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('dx-in', async () => { try { await sync.signIn(); } catch (e) { toast(e.message); } });
  on('dx-now', async () => { closeLayer(); await sync.sync(); renderList(); toast(sync.status === 'idle' ? '同期しました' : '同期できませんでした'); });
  on('dx-out', async () => { await sync.signOut(); closeLayer(); renderList(); toast('ログアウトしました'); });
  on('dx-close', closeLayer); bgClose(closeLayer);
}
