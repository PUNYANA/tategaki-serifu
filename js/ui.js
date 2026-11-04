// 画面の小物（一覧と編集で共通）
export const $ = id => document.getElementById(id);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const spacer = () => { const s = document.createElement('span'); s.className = 'sp'; return s; };
export function btn(label, fn, cls = '', dis = false) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = cls; b.disabled = dis; b.onclick = fn; return b;
}
export function toast(t) {
  const el = $('toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}
export function closeLayer() { $('layer').innerHTML = ''; }
export function bgClose(fn) {
  $('layer').querySelector('.sheet-bg').addEventListener('click', e => { if (e.target.classList.contains('sheet-bg')) fn(); });
}

/* ---- 色のモード（端末ごとに覚える） ----
   auto：端末の設定に合わせる（ライト／ダーク）。paper（紙）と night（夜）は目にやさしい暖かい色 */
export const THEMES = [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク'], ['paper', '紙'], ['night', '夜']];
const THEME_BAR = { light: '#f6f7f5', dark: '#15181e', paper: '#f3ead6', night: '#1f1c18' };
export function getTheme() { try { return localStorage.getItem('tategaki-theme') || 'auto'; } catch (e) { return 'auto'; } }
export function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  // 画面のいちばん上（時計などの帯）の色も合わせる
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    if (t === 'auto') { m.content = m.media.includes('dark') ? THEME_BAR.dark : THEME_BAR.light; }
    else m.content = THEME_BAR[t];
  });
}
export function setTheme(t) { try { localStorage.setItem('tategaki-theme', t); } catch (e) { } applyTheme(t); }
// 色を選ぶボタンの並び（今の色に印）
export function themeButtons(box) {
  const draw = () => {
    box.innerHTML = ''; box.className = 'seg theme-seg';
    THEMES.forEach(([k, label]) => { const b = btn(label, () => { setTheme(k); draw(); }, getTheme() === k ? 'on' : ''); b.dataset.theme = k; box.appendChild(b); });
  };
  draw();
}
