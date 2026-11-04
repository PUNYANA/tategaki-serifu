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
