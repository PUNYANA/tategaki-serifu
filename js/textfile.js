// 原稿ファイル（仕様書 3-1）とアプリ内データの相互変換
export const COLORS = ['#d9534f', '#3a8fb7', '#e0a100', '#4f9d69', '#8e6cc1', '#d36aa0', '#5b7083', '#c46a2b'];
export const count = s => [...s.replace(/\s/g, '')].length;
export const splitParas = v => v.replace(/\r/g, '').split(/\n[ \t]*\n+/).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim());

// 照合順：name → aliases（ゲストは手順2で追加）
export const findCast = (cast, name) =>
  cast.find(c => c.name === name) || cast.find(c => Array.isArray(c.aliases) && c.aliases.includes(name)) || null;

// 本文（セリフ・区切り）を読む。知らない話者はキャラ表に足す（試作版の読み込みと同じ）
export function parseBody(t, cast) {
  return splitParas(t).map(s => {
    if (/^-{3,}/.test(s)) return { type: 'div' };
    const m = s.match(/^([^\n：:「」]{1,12})[：:]([\s\S]*)$/);
    if (m && m[1].trim()) {
      const name = m[1].trim(); let c = findCast(cast, name);
      if (!c) { c = { id: 'c' + Date.now().toString(36) + cast.length, name, color: COLORS[cast.length % COLORS.length], aliases: [] }; cast.push(c); }
      return { type: 'line', text: m[2].replace(/^\n+/, ''), who: c.id };
    }
    return { type: 'line', text: s };
  });
}

// ファイル全体を読む。冒頭の @ 行がメタ情報。@title 以外の @ 行はそのまま残して書き戻す
export function parseDoc(text, cast) {
  const lines = text.replace(/\r/g, '').split('\n');
  let title = null, k = 0; const meta = [];
  while (k < lines.length && lines[k].startsWith('@')) {
    const m = lines[k].match(/^@title[ \t]+(.*)$/);
    if (m) title = m[1].trim(); else meta.push(lines[k]);
    k++;
  }
  const n = cast.length;
  const items = parseBody(lines.slice(k).join('\n'), cast);
  return { title, meta, items, added: cast.length !== n };
}

export function serializeDoc({ title, meta = [], items }, cast) {
  const head = ['@title ' + title, ...meta].join('\n');
  // 最初の区切りより前にセリフがあればそこが P1 なので、最初の区切りは P2
  let pg = items.length && items[0].type !== 'div' ? 1 : 0; const body = [];
  for (const i of items) {
    if (i.type === 'div') { pg++; body.push('--- P' + pg); continue; }
    if (!i.text.trim()) continue;
    const w = cast.find(c => c.id === i.who);
    body.push(w ? `${w.name}：${i.text}` : i.text);
  }
  return body.length ? head + '\n\n' + body.join('\n\n') + '\n' : head + '\n';
}

export function docStats(items) {
  const lines = items.filter(i => i.type === 'line' && i.text.trim());
  return { lines: lines.length, chars: lines.reduce((a, i) => a + count(i.text), 0) };
}

// @title 行だけを差し替える（名前変更・複製用）
export function setTitle(text, title) {
  const lines = text.replace(/\r/g, '').split('\n');
  for (let k = 0; k < lines.length && lines[k].startsWith('@'); k++) {
    if (/^@title([ \t]|$)/.test(lines[k])) { lines[k] = '@title ' + title; return lines.join('\n'); }
  }
  return '@title ' + title + '\n' + lines.join('\n');
}
