// Dropbox API v2 の薄い窓口。ログインは OAuth 2.0 PKCE（サーバー不要・App secret 不要）
// 権限は App folder（アプリ/縦書きセリフ帳/ 以下だけ）。パスはそのフォルダからの相対（"/作品/第1話.txt"）
import { DROPBOX_APP_KEY } from './config.js?v=43';
import * as db from './db.js?v=43';

const AUTH = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';
// ログインから戻ってくるアドレス。Dropbox に登録したものと1文字でも違うと断られるので、index.html は付けない形にそろえる
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

export const configured = () => !!DROPBOX_APP_KEY;
// ホーム画面から起動したアプリ（全画面）として動いているか
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let tok = null; // { access, refresh, exp }
export async function loadToken() { tok = (await db.getMeta('dbx')) || null; return !!tok; }
export const signedIn = () => !!(tok && tok.refresh);

export class DbxError extends Error {
  constructor(status, summary) { super(summary || ('HTTP ' + status)); this.status = status; this.summary = summary || ''; }
  get conflict() { return /conflict/.test(this.summary); }
  get notFound() { return /not_found/.test(this.summary); }
}

/* ---- ログイン ---- */
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function signIn() {
  if (!crypto.subtle) throw new Error('この画面は https（または PC の localhost）でないと Dropbox にログインできません');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  // ホーム画面から起動したときに戻ってこられるよう、localStorage に残す（sessionStorage だと消えることがある）
  localStorage.setItem('dbx-pkce', JSON.stringify({ verifier, state, standalone: isStandalone() }));
  const q = new URLSearchParams({ client_id: DROPBOX_APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirectUri(), token_access_type: 'offline', state });
  location.href = AUTH + '?' + q;
}
// Dropbox から戻ってきたとき（?code=…）にトークンへ交換する。戻ってきたのでなければ false
// 戻り値の inSheet：ホーム画面のアプリからログインして、iOS の「アプリ内のブラウザ」の窓の中に戻ってきた（＝その窓は閉じてもらう）
export async function finishSignIn() {
  const u = new URL(location.href), code = u.searchParams.get('code'), state = u.searchParams.get('state'), err = u.searchParams.get('error');
  if (!code && !err) return false;
  history.replaceState(null, '', redirectUri()); // アドレスから code を消す
  const saved = JSON.parse(localStorage.getItem('dbx-pkce') || 'null'); localStorage.removeItem('dbx-pkce');
  if (err) throw new Error('Dropbox のログインをやめました');
  if (!saved || saved.state !== state) throw new Error('Dropbox のログインをやり直してください（確認用の値が一致しません）');
  const r = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: DROPBOX_APP_KEY, redirect_uri: redirectUri(), code_verifier: saved.verifier }) });
  if (!r.ok) throw new Error('Dropbox のログインに失敗しました（' + r.status + '）');
  const j = await r.json();
  tok = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  await db.setMeta('dbx', tok);
  return { inSheet: !!saved.standalone && !isStandalone() };
}
export async function signOut() {
  try { if (tok) await fetch(API + 'auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + tok.access } }); } catch (e) { }
  tok = null; await db.setMeta('dbx', null);
}
async function access() {
  if (!tok) throw new DbxError(401, 'not signed in');
  if (Date.now() < tok.exp) return tok.access;
  const r = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: DROPBOX_APP_KEY }) });
  if (!r.ok) { if (r.status === 400 || r.status === 401) { tok = null; await db.setMeta('dbx', null); } throw new DbxError(r.status, 'token refresh failed'); }
  const j = await r.json(); tok = { ...tok, access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  await db.setMeta('dbx', tok); return tok.access;
}

/* ---- 呼び出し ---- */
// Dropbox-API-Arg ヘッダーには日本語をそのまま入れられないので \uXXXX にする
const headerJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
async function call(url, init, retry = true) {
  const a = await access();
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + a } });
  if (r.status === 401 && retry) { tok.exp = 0; return call(url, init, false); }
  if (!r.ok) { let s = ''; try { const t = await r.text(); try { s = JSON.parse(t).error_summary || t; } catch (e) { s = t; } } catch (e) { } throw new DbxError(r.status, s); }
  return r;
}
export async function rpc(name, args) {
  const r = await call(API + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  return r.json();
}
export async function download(path) {
  const r = await call(CONTENT + 'files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': headerJson({ path }) } });
  const meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}');
  return { text: await r.text(), meta };
}
// mode：'add'（なければ作る）／'overwrite'／{ update: rev }（rev が一致したときだけ上書き。食い違えば衝突のエラー）
export async function upload(path, text, mode) {
  const m = typeof mode === 'string' ? { '.tag': mode } : { '.tag': 'update', update: mode.update };
  const r = await call(CONTENT + 'files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ path, mode: m, autorename: false, mute: true, strict_conflict: true }) },
    body: new Blob([text], { type: 'text/plain;charset=utf-8' }),
  });
  return r.json();
}
