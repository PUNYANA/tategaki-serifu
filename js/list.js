// 原稿一覧：作品フォルダごとに原稿を並べる（更新順）
import { $, esc, btn, toast, closeLayer, bgClose, themeButtons } from './ui.js?v=42';
import { serializeDoc, docStats, setTitle, COLORS, pickColor } from './textfile.js?v=42';
import * as db from './db.js?v=42';
import * as sync from './sync.js?v=42';

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
  if (!v) return 'タイトルを入れてください';
  if (/[\\/:*?"<>|]/.test(v)) return '次の文字は使えません：\\ / : * ? " < > |';
  if (/^[_.]/.test(v)) return '「_」か「.」で始まるタイトルは使えません';
  if (v.length > 80) return 'タイトルが長すぎます';
  return '';
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const docCheck = (folder, self) => v => badName(v) || (S.docs.some(d => d.folder === folder && d !== self && same(d.name, v)) ? '同じフォルダに同じタイトルのノートがあります' : '');
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
    else if (b.dataset.tog != null) toggleFolder(b.dataset.tog);
    else if (b.dataset.fold != null) { const f = S.folders.find(x => x.name === b.dataset.fold); f && folderMenu(f); }
    else if (b.dataset.open) { const d = S.docs.find(x => x.id === b.dataset.open); d && onOpen(d); }
    else if (b.dataset.more) { const d = S.docs.find(x => x.id === b.dataset.more); d && docMenu(d); }
  });
}

// 同期の印。文字の説明だけでなく形でも区別する（仕様書 5-1）
const MARK = { synced: ['✓', '同期済み'], pending: ['↑', '未送信あり'], conflict: ['⚠', '衝突あり'] };
const mark = d => { const s = sync.docState(d); return s ? `<span class="sm ${s}" title="${MARK[s][1]}" aria-label="${MARK[s][1]}">${MARK[s][0]}</span>` : ''; };
// 右上の Dropbox ボタンに出す、全体の同期の状態
const STATUS = { idle: ['✓', '同期済み'], busy: ['↻', '送信中'], offline: ['⦸', 'オフライン・端末に保存済み'], error: ['!', '送信できません'], local: ['', 'つないでいません'] };

// 閉じているフォルダ（端末ごとに覚える）
const closedKey = 'tategaki-closed';
const closed = () => { try { return new Set(JSON.parse(localStorage.getItem(closedKey) || '[]')); } catch (e) { return new Set(); } };
function toggleFolder(name) { const s = closed(); s.has(name) ? s.delete(name) : s.add(name); try { localStorage.setItem(closedKey, JSON.stringify([...s])); } catch (e) { } renderList(); }

export function renderList() {
  const shut = closed();
  const hdr = $('hdr'); hdr.innerHTML = '';
  const st = sync.signedIn() ? (S.docs.some(d => sync.docState(d) === 'conflict') && sync.status === 'idle' ? ['⚠', '衝突あり'] : STATUS[sync.status]) : STATUS.local;
  const db_ = btn(`${st[0] ? st[0] + ' ' : ''}Dropbox`, dbxSheet, 'dbx ' + sync.status); db_.setAttribute('aria-label', 'Dropbox：' + st[1]);
  hdr.append(db_);
  // 今すぐ Dropbox の変更を取り込む（つないでいるときだけ）
  if (sync.signedIn()) { const r = btn('↻', async () => { await sync.sync(); toast(sync.status === 'idle' ? '最新にしました' : '取り込めませんでした'); }, 'reload'); r.setAttribute('aria-label', '今すぐ取り込む'); hdr.append(r); }
  hdr.append(btn('表示', themeSheet), btn('＋ フォルダ', newFolder));
  const folders = [...S.folders].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  $('listview').innerHTML = folders.map(f => {
    const docs = sortedDocs(f);
    const rows = docs.map(d => `<li class="doc"><button type="button" class="open" data-open="${d.id}"><span class="dn">${mark(d)}${esc(d.name)}</span>`
      + `<span class="dm">${fmtDate(d.updated)}　セリフ ${d.stats.lines}　${d.stats.chars}字</span></button>`
      + `<button type="button" class="more" data-more="${d.id}" aria-label="${esc(d.name)}の操作">…</button></li>`).join('');
    const c = shut.has(f.name);
    return `<section class="fold${c ? ' closed' : ''}"><div class="fh"><button type="button" class="ftog" data-tog="${esc(f.name)}" aria-expanded="${!c}"><span class="arw" aria-hidden="true">${c ? '▸' : '▾'}</span><h2>${esc(f.name)}</h2>${c ? `<span class="cnt">${docs.length}</span>` : ''}</button><span class="sp"></span><button type="button" data-new="${esc(f.name)}">＋ ノート</button><button type="button" class="more" data-fold="${esc(f.name)}" aria-label="${esc(f.name)}の操作">…</button></div>`
      + (docs.length ? `<ul class="docs">${rows}</ul>` : '<p class="empty">まだノートがありません</p>') + '</section>';
  }).join('') || '<p class="empty">右上の「＋ フォルダ」から作品フォルダを作ってください</p>';
}

/* ---- 名前を打つシート ---- */
function nameSheet({ title, value, ok, check, done }) {
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2>
    <input type="search" enterkeyhint="done" id="tx" name="sheet-text" value="${esc(value)}" aria-label="${esc(title)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><p class="err" id="tx-err"></p>
    <div class="row"><span class="sp"></span><button type="button" id="tx-cancel">やめる</button><button type="button" class="pri" id="tx-ok">${esc(ok)}</button></div></div></div>`;
  const inp = $('tx');
  const go = () => { const v = inp.value.trim(); const e = check(v); if (e) { $('tx-err').textContent = e; return; } closeLayer(); done(v); };
  $('tx-ok').onclick = go;
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } };
  $('tx-cancel').onclick = closeLayer; bgClose(closeLayer);
  inp.focus(); inp.select();
}

function newDocSheet(folder) {
  nameSheet({
    title: `「${folder}」にノートを作る`, value: uniqueName(folder, '無題'), ok: '作る', check: docCheck(folder, null),
    done: async v => { const d = newDoc(folder, v); S.docs.push(d); await db.put('docs', d); sync.schedule(); onOpen(d); },
  });
}
function newFolder() {
  nameSheet({
    title: 'フォルダを作る', value: '', ok: '作る',
    check: v => badName(v) || (S.folders.some(f => same(f.name, v)) ? '同じタイトルのフォルダがあります' : ''),
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
      <p>${sync.isCopy(d) ? 'この版の中身を、元のノートに移します。' : '別の版を消します。'}</p></section>` : '';
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="ノートの操作">
    <h2>${esc(d.name)}</h2><p>${esc(d.folder)}　${fmtDate(d.updated)}　セリフ ${d.stats.lines}　${d.stats.chars}字</p>${clash}
    <section><h3>タイトルを変える</h3><div class="row"><input type="search" enterkeyhint="done" id="dm-ttl" name="q-doc" value="${esc(d.name)}" aria-label="ノートのタイトル" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="flex:1"><button type="button" id="dm-ren">変更</button></div><p class="err" id="dm-err"></p></section>
    ${S.folders.length > 1 ? `<section><h3>別のフォルダへ移す</h3><div class="row"><select id="dm-to" aria-label="移す先のフォルダ">${S.folders.filter(f => f.name !== d.folder).sort((a, b) => a.name.localeCompare(b.name, 'ja')).map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('')}</select><button type="button" id="dm-move">移す</button></div></section>` : ''}
    <section><div class="row"><button type="button" id="dm-dup">複製</button><button type="button" class="danger" id="dm-del">削除</button><span class="sp"></span><button type="button" class="pri" id="dm-close">閉じる</button></div></section>
  </div></div>`;
  const rename = async () => {
    const v = $('dm-ttl').value.trim(); if (v === d.name) { closeLayer(); return; }
    const e = docCheck(d.folder, d)(v); if (e) { $('dm-err').textContent = e; return; }
    const fo = S.folders.find(x => x.name === d.folder); if (fo && fo.order) { const k = fo.order.indexOf(d.name); if (k >= 0) { fo.order[k] = v; fo.castDirty = true; await db.put('folders', fo); } }
    d.name = v; d.text = setTitle(d.text, v); d.updated = Date.now(); d.dirty = true; d.sample = false; await db.put('docs', d); sync.schedule();
    closeLayer(); renderList(); toast('タイトルを変えました');
  };
  if (pair.length) $('dm-keep').onclick = async () => { const k = await sync.resolve(d); closeLayer(); renderList(); toast(`「${k.name}」の1本にしました`); };
  $('dm-ren').onclick = rename;
  $('dm-ttl').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); rename(); } };
  // 別のフォルダへ移す（移す先に同じ名前があれば「名前 2」のようにする）。Dropbox でも移す
  if ($('dm-move')) $('dm-move').onclick = async () => {
    const to = $('dm-to').value; if (!to) return;
    const name = uniqueName(to, d.name); d.folder = to;
    if (name !== d.name) { d.name = name; d.text = setTitle(d.text, name); }
    d.dirty = true; d.sample = false; d.updated = Date.now(); await db.put('docs', d); sync.schedule();
    closeLayer(); renderList(); toast(`「${to}」へ移しました`);
  };
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
    body = `<p>つなぐと、ノートを Dropbox の「アプリ」フォルダの中にある、このアプリ専用のフォルダ（Dropbox に登録したアプリと同じ呼び方のフォルダ）に普通のテキストファイルとして保存し、ほかの端末と同期します。このアプリが触れるのは、そのフォルダの中だけです。つながなくても、この端末の中だけで使えます。</p>
      <div class="row"><button type="button" class="pri" id="dx-in">Dropbox につなぐ</button></div>`;
  } else {
    const label = { idle: '同期済み', busy: '送信中', offline: 'オフライン・端末に保存済み', error: '送信できません', local: '' }[sync.status] || '';
    const n = S.docs.filter(d => sync.docState(d) === 'conflict').length;
    body = `<p>状態：<b>${label}</b>　最後に同期：${when(sync.lastSync)}</p>`
      + (sync.status === 'error' && sync.lastError ? `<p class="err">${esc(sync.lastError)}</p>` : '')
      + (n ? `<p class="err">⚠ 衝突しているノートがあります（${n}冊）。一覧の「…」から、残す版を選んでください。</p>` : '')
      + `<div class="row"><button type="button" class="pri" id="dx-now">今すぐ同期</button><span class="sp"></span><button type="button" id="dx-out">ログアウト</button></div>
      <p>ログアウトしても、この端末のノートは消えません。</p>`;
  }
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="Dropbox"><h2>Dropbox</h2>${body}
    <div class="row"><span class="ver">アプリの版：${esc(new URL(import.meta.url).searchParams.get('v') || '—')}</span><span class="sp"></span><button type="button" id="dx-close">閉じる</button></div></div></div>`;
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('dx-in', async () => { try { await sync.signIn(); } catch (e) { toast(e.message); } });
  on('dx-now', async () => { closeLayer(); await sync.sync(); renderList(); toast(sync.status === 'idle' ? '同期しました' : '同期できませんでした'); });
  on('dx-out', async () => { await sync.signOut(); closeLayer(); renderList(); toast('ログアウトしました'); });
  on('dx-close', closeLayer); bgClose(closeLayer);
}

/* ---- フォルダの操作（名前変更・キャラ表・削除） ---- */
function folderMenu(f, confirming = false) {
  const docs = S.docs.filter(d => d.folder === f.name);
  if (confirming) {
    $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="フォルダの削除の確認">
      <h2>「${esc(f.name)}」を削除しますか？</h2>
      <p>${docs.length ? `中のノート ${docs.length}冊も一緒に消えます。` : ''}この端末から消えます。${sync.signedIn() ? 'Dropbox からも消えます（Dropbox のゴミ箱から戻せます）。' : '元に戻せません。'}</p>
      <div class="row"><span class="sp"></span><button type="button" id="fm-no">やめる</button><button type="button" class="danger" id="fm-yes">削除する</button></div></div></div>`;
    $('fm-no').onclick = () => folderMenu(f);
    $('fm-yes').onclick = async () => {
      const last = await db.getMeta('last');
      for (const d of docs) { S.docs.splice(S.docs.indexOf(d), 1); await db.del('docs', d.id); if (d.id === last) await db.setMeta('last', null); }
      S.folders.splice(S.folders.indexOf(f), 1); await db.del('folders', f.name); await sync.folderRemoved(f);
      closeLayer(); renderList(); toast('フォルダを削除しました');
    };
    bgClose(closeLayer); return;
  }
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="フォルダの操作">
    <h2>${esc(f.name)}</h2><p>ノート ${docs.length}冊　レギュラー ${f.cast.length}人</p>
    <section><h3>タイトルを変える</h3><div class="row"><input type="search" enterkeyhint="done" id="fm-ttl" name="q-folder" value="${esc(f.name)}" aria-label="フォルダ" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="flex:1"><button type="button" id="fm-ren">変更</button></div><p class="err" id="fm-err"></p></section>
    <section><div class="row"><button type="button" id="fm-sort">並べ替え</button><button type="button" id="fm-cast">キャラ表（レギュラー）</button><button type="button" class="danger" id="fm-del">フォルダを削除</button><span class="sp"></span><button type="button" class="pri" id="fm-close">閉じる</button></div></section>
  </div></div>`;
  const rename = async () => {
    const v = $('fm-ttl').value.trim(); if (v === f.name) { closeLayer(); return; }
    const e = badName(v) || (S.folders.some(x => x !== f && same(x.name, v)) ? '同じタイトルのフォルダがあります' : '');
    if (e) { $('fm-err').textContent = e; return; }
    const old = f.name; await db.del('folders', old); f.name = v;
    for (const d of docs) { d.folder = v; await db.put('docs', d); }
    await sync.folderRenamed(f, old); // フォルダも保存し直す
    closeLayer(); renderList(); toast('フォルダのタイトルを変えました');
  };
  $('fm-ren').onclick = rename;
  $('fm-ttl').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); rename(); } };
  $('fm-cast').onclick = () => castSheet(f);
  $('fm-sort').onclick = () => sortSheet(f);
  $('fm-del').onclick = () => folderMenu(f, true);
  $('fm-close').onclick = closeLayer; bgClose(closeLayer);
}

// フォルダのキャラ表（レギュラー）を、ノートを開かずに編集する
function castSheet(f) {
  const oldNames = new Map(f.cast.map(c => [c.id, c.name]));
  const close = async () => {
    f.cast = f.cast.filter(c => c.name.trim());
    // 名前を変えたら古い名前を別名に残す（過去の原稿の話者名と照合するため）
    f.cast.forEach(c => { const old = oldNames.get(c.id); if (old && old !== c.name) c.aliases = [...new Set([...(c.aliases || []), old])].filter(a => a !== c.name); });
    f.castDirty = true; await db.put('folders', f); sync.schedule(); closeLayer(); renderList();
  };
  let asking = null, step = 0; // 「消す」を押して確かめているキャラの id と、何回目の確かめか（1→2 と確かめてから消す）
  const draw = () => {
    $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="キャラ表">
      <h2>キャラ表：${esc(f.name)}</h2><p>この作品の全部のノートで使うキャラ（レギュラー）です。色の丸を押すと色が変わります。▲▼で順番を変えます（セリフの上で話者を選ぶときの並び）。その回だけのキャラ（ゲスト）は、ノートの中でセリフの上の話者の欄から足します。</p>
      <div id="fcl" class="cast-list"></div>
      <div class="row"><button type="button" id="fcl-add">＋ レギュラーを追加</button><span class="sp"></span><button type="button" class="pri" id="fcl-close">閉じる</button></div></div></div>`;
    const box = $('fcl');
    f.cast.forEach((c, i) => {
      const r = document.createElement('div');
      if (asking === c.id) {
        // 消す前にもう一度確かめる（全部のノートで、このキャラのセリフが話者なしになる）
        r.className = 'cast-ask';
        const nm = esc(c.name || '（未入力）');
        r.innerHTML = step === 1
          ? `<p>「${nm}」を消しますか？この作品の全部のノートで、このキャラのセリフは話者なしになります。</p>
          <div class="row"><span class="sp"></span><button type="button">やめる</button><button type="button" class="danger">消す</button></div>`
          : `<p><b>最後の確認です。</b>「${nm}」を本当に消しますか？</p>
          <div class="row"><span class="sp"></span><button type="button">やめる</button><button type="button" class="danger">本当に消す</button></div>`;
        const [no, yes] = r.querySelectorAll('button');
        no.onclick = () => { asking = null; step = 0; draw(); };
        yes.onclick = () => {
          if (step === 1) { step = 2; draw(); return; }
          f.cast.splice(f.cast.indexOf(c), 1); asking = null; step = 0; draw();
        };
        box.appendChild(r); return;
      }
      r.className = 'cast';
      r.innerHTML = `<button type="button" class="swatch" aria-label="色を変える" style="--c:${c.color}"></button><input type="search" enterkeyhint="done" id="fcn-${c.id}" name="q-${c.id}" value="${esc(c.name)}" placeholder="キャラ" aria-label="キャラ" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button type="button" class="mv" aria-label="上へ" ${i ? '' : 'disabled'}>▲</button><button type="button" class="mv" aria-label="下へ" ${i < f.cast.length - 1 ? '' : 'disabled'}>▼</button><button type="button" class="danger">消す</button>`;
      const [sw, inp, up, dn, del] = r.children;
      sw.onclick = () => { c.color = COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length]; draw(); };
      inp.oninput = e => { c.name = e.target.value.replace(/[：:]/g, ''); };
      const move = j => { [f.cast[i], f.cast[j]] = [f.cast[j], f.cast[i]]; draw(); };
      up.onclick = () => move(i - 1); dn.onclick = () => move(i + 1);
      del.onclick = () => { asking = c.id; step = 1; draw(); };
      box.appendChild(r);
    });
    if (!f.cast.length) box.innerHTML = '<p>まだレギュラーがいません。</p>';
    $('fcl-add').onclick = () => { const id = 'c' + Date.now().toString(36); f.cast.push({ id, name: '', color: pickColor(f.cast.map(c => c.color)), aliases: [] }); draw(); const el = $('fcn-' + id); el && el.focus(); };
    $('fcl-close').onclick = close; bgClose(close);
  };
  draw();
}

/* ---- 表示（色のモード） ---- */
function themeSheet() {
  $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="表示"><h2>表示</h2>
    <section><h3>色</h3><div id="th"></div>
      <p>「紙」「緑」「青」は目にやさしい明るい色です。紙＝生成りの紙のような色、緑・青＝淡くくすませた色で、まぶしさを抑えています。「自動」は端末のライト／ダークの設定に合わせます。この端末だけに覚えます。</p></section>
    <div class="row"><span class="sp"></span><button type="button" class="pri" id="th-close">閉じる</button></div></div></div>`;
  themeButtons($('th'));
  $('th-close').onclick = closeLayer; bgClose(closeLayer);
}

/* ---- ノートの並べ替え ----
   フォルダの order（ノートの名前の並び）の順に並べる。order にないノート（並べ替えたあとで作ったものなど）は、その後ろに更新の新しい順。
   order は作品フォルダの _cast.json に一緒に入れて、ほかの端末と同じ順番にする */
function sortedDocs(f) {
  const ord = f.order || [], rank = d => { const k = ord.indexOf(d.name); return k < 0 ? Infinity : k; };
  return S.docs.filter(d => d.folder === f.name).sort((a, b) => (rank(a) - rank(b)) || (b.updated - a.updated));
}
function sortSheet(f) {
  const draw = () => {
    const docs = sortedDocs(f);
    $('layer').innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="並べ替え"><h2>並べ替え：${esc(f.name)}</h2>
      <p>▲▼で順番を変えます。ほかの端末でも同じ順番になります。</p>
      <ul class="sortl">${docs.map((d, i) => `<li><span class="nm">${esc(d.name)}</span><button type="button" data-up="${i}" ${i ? '' : 'disabled'} aria-label="上へ">▲</button><button type="button" data-dn="${i}" ${i < docs.length - 1 ? '' : 'disabled'} aria-label="下へ">▼</button></li>`).join('')}</ul>
      <div class="row"><span class="sp"></span><button type="button" class="pri" id="so-close">閉じる</button></div></div></div>`;
    const swap = async (i, j) => {
      const names = docs.map(d => d.name); [names[i], names[j]] = [names[j], names[i]];
      f.order = names; f.castDirty = true; await db.put('folders', f); sync.schedule(); draw();
    };
    $('layer').querySelectorAll('[data-up]').forEach(b => b.onclick = () => swap(+b.dataset.up, +b.dataset.up - 1));
    $('layer').querySelectorAll('[data-dn]').forEach(b => b.onclick = () => swap(+b.dataset.dn, +b.dataset.dn + 1));
    const close = () => { closeLayer(); renderList(); };
    $('so-close').onclick = close; bgClose(close);
  };
  draw();
}
