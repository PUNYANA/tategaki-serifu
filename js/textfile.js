// 原稿ファイル（仕様書 3-1）とアプリ内データの相互変換
export const COLORS = ['#d9534f', '#3a8fb7', '#e0a100', '#4f9d69', '#8e6cc1', '#d36aa0', '#5b7083', '#c46a2b'];
export const count = s => [...s.replace(/\s/g, '')].length;
export const splitParas = v => v.replace(/\r/g, '').split(/\n[ \t]*\n+/).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim());

// キャラは2種類（仕様書 4）
//   レギュラー：作品フォルダのキャラ表。その作品の全原稿で使う。{ id:'c…', name, color, aliases }
//   ゲスト    ：原稿ファイルの @guest 行。その原稿だけで使う。      { id:'g…', name, color }
// 話者名の照合順：その回のゲスト → レギュラーの name → レギュラーの aliases
export const findCast = (cast, name) =>
  cast.find(c => c.name === name) || cast.find(c => Array.isArray(c.aliases) && c.aliases.includes(name)) || null;
export const findSpeaker = (name, regulars, guests) => guests.find(c => c.name === name) || findCast(regulars, name);

// まだ誰も使っていない色を選ぶ（全部使っていたら順番に回す）
export function pickColor(used) {
  return COLORS.find(c => !used.includes(c)) || COLORS[used.length % COLORS.length];
}
let gseq = 0;
export function newGuest(name, regulars, guests) {
  return { id: 'g' + Date.now().toString(36) + (gseq++), name, color: pickColor([...regulars, ...guests].map(c => c.color)) };
}

// 本文（セリフ・区切り）を読む。レギュラーにもゲストにもいない話者は、その原稿のゲストとして足す
export function parseBody(t, regulars, guests) {
  return splitParas(t).map(s => {
    if (/^-{3,}/.test(s)) return { type: 'div' };
    const m = s.match(/^([^\n：:「」]{1,12})[：:]([\s\S]*)$/);
    if (m && m[1].trim()) {
      const name = m[1].trim(); let c = findSpeaker(name, regulars, guests);
      if (!c) { c = newGuest(name, regulars, guests); guests.push(c); }
      return { type: 'line', text: m[2].replace(/^\n+/, ''), who: c.id };
    }
    return { type: 'line', text: s };
  });
}

// ファイル全体を読む。冒頭の @ 行がメタ情報。@title・@guest 以外の @ 行はそのまま残して書き戻す
export function parseDoc(text, regulars) {
  const lines = text.replace(/\r/g, '').split('\n');
  let title = null, k = 0; const meta = [], guests = [];
  while (k < lines.length && lines[k].startsWith('@')) {
    const l = lines[k]; let m;
    if ((m = l.match(/^@title[ \t]+(.*)$/))) title = m[1].trim();
    else if ((m = l.match(/^@guest[ \t]+(.+?)(?:[ \t]+(#[0-9a-fA-F]{3,8}))?[ \t]*$/))) {
      const g = newGuest(m[1].trim(), regulars, guests); if (m[2]) g.color = m[2].toLowerCase(); guests.push(g);
    } else meta.push(l);
    k++;
  }
  const n = guests.length;
  const items = parseBody(lines.slice(k).join('\n'), regulars, guests);
  return { title, meta, guests, items, added: guests.length !== n };
}

export function serializeDoc({ title, meta = [], guests = [], items }, regulars) {
  const head = ['@title ' + title, ...guests.filter(g => g.name.trim()).map(g => `@guest ${g.name.trim()} ${g.color}`), ...meta].join('\n');
  const all = [...guests, ...regulars];
  // 最初の区切りより前にセリフがあればそこが P1 なので、最初の区切りは P2
  let pg = items.length && items[0].type !== 'div' ? 1 : 0; const body = [];
  for (const i of items) {
    if (i.type === 'div') { pg++; body.push('--- P' + pg); continue; }
    if (!i.text.trim()) continue;
    const w = all.find(c => c.id === i.who);
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
