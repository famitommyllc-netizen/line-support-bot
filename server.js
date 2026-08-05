import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 3000;
// REPLY_MODE: 'notify'（既定・顧客に自動送信せず運営者へ通知）/ 'auto'（顧客へ直接返信）
const REPLY_MODE = process.env.REPLY_MODE || 'notify';

const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH || new URL('./knowledge.md', import.meta.url).pathname;
const BASE_DIR = path.dirname(KNOWLEDGE_PATH);
const RULES_PATH = process.env.RULES_PATH || path.join(BASE_DIR, 'rules.md');
const MANUALS_DIR = process.env.MANUALS_DIR || path.join(BASE_DIR, 'manuals');
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'conversations');
const PENDING_FILE = path.join(BASE_DIR, 'pending.json');
const BOOKINGS_FILE = path.join(BASE_DIR, 'bookings.json');
// 出張レッスンコース用の規約。教室に通うコースは KNOWLEDGE_PATH 側。
const KNOWLEDGE_VISIT_PATH = process.env.KNOWLEDGE_VISIT_PATH || path.join(BASE_DIR, 'knowledge-visit.md');
const ONBOARDING_FILE = path.join(BASE_DIR, 'onboarding.json');
const STUDENTS_FILE = path.join(BASE_DIR, 'students.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// 事業ごとの設定（教室名・講師名・料金・場所）。
// 実データはこの公開リポジトリには持たず、VPS側の settings.json に置く（knowledge.md と同じ考え方）。
const SETTINGS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'settings.json'), 'utf8')); } catch { return {}; }
})();

// 新規登録の案内（オンボーディング）
const SCHOOL_NAME = process.env.SCHOOL_NAME || SETTINGS.schoolName || '当教室';
// 案内役の名前。お客様扱いはせず、真摯・誠実・丁寧に、へりくだりすぎない言葉遣いで話す
const BOT_NAME = process.env.BOT_NAME || SETTINGS.botName || '案内係';
// レッスン場所の呼び方（例：「◯◯教室」）
const STUDIO_PLACE = process.env.STUDIO_PLACE || SETTINGS.studioPlace || '教室';
// 支払いリンク（Stripe の Payment Link を事前に作って URL を渡す）
const PAYMENT_LINK_URL = process.env.PAYMENT_LINK_URL || SETTINGS.paymentLinkUrl || '';
// 料金（税込）。0 のときは金額を出さず、担当から案内する扱いにする
const FEE_ENROLL = Number(process.env.FEE_ENROLL || SETTINGS.feeEnroll || 0);
const FEE_MONTHLY = Number(process.env.FEE_MONTHLY || SETTINGS.feeMonthly || 0);
const FEE_VISIT = Number(process.env.FEE_VISIT || SETTINGS.feeVisit || 0);
const MIN_AGE = Number(process.env.MIN_AGE || SETTINGS.minAge || 20);

// Gカレンダー登録（GAS経由）。GASのウェブアプリURLとtokenをenvで渡す
const GAS_BOOK_URL = process.env.GAS_BOOK_URL || '';
const GAS_BOOK_TOKEN = process.env.GAS_BOOK_TOKEN || '';
// レッスンを入れられる先生（GAS側 TEACHERS の key と一致させる）
const TEACHERS = (process.env.TEACHERS || SETTINGS.teachers || '').split(',').map((s) => s.trim()).filter(Boolean);

// 運営者（あなた）のLINE userId
const OPERATOR_ID =
  process.env.OPERATOR_USER_ID ||
  (() => { try { return fs.readFileSync(path.join(BASE_DIR, 'operator.txt'), 'utf8').trim(); } catch { return ''; } })();
console.log(`mode=${REPLY_MODE} operator=${OPERATOR_ID ? 'set' : 'MISSING'}`);

// ---------- 知識・ルール ----------
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function readManuals() {
  try {
    return fs.readdirSync(MANUALS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSafe(path.join(MANUALS_DIR, f)))
      .join('\n\n---\n\n')
      .trim();
  } catch { return ''; }
}

function buildSystemPrompt() {
  const rules = readFileSafe(RULES_PATH).trim();
  const manuals = readManuals();
  const visit = readFileSafe(KNOWLEDGE_VISIT_PATH).trim();
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' });
  return `あなたはLINEでの顧客対応アシスタントです。下の「知識」だけを根拠に、丁寧語で簡潔に日本語で返信してください。

現在日時（日本時間）: ${now}
※退会の最短時期などは、この現在日時と規約の期限ルールから計算して具体的に案内してください。

基本ルール:
- 知識に書かれていないことは断定せず「担当者が確認のうえご連絡します」と伝える。
- 事実を作らない・盛らない。
- 相手を急かさず、押し付けない丁寧なトーンで。
- LINEでは太字などの記号（**）は表示されないので使わない。
${rules ? `\n# 追加の回答ルール（運用者が定義）\n${rules}\n` : ''}${manuals ? `\n# 対応マニュアル（退会・未払い等はこの決まりごとに沿って、状況・金額・期限を差し込んで綺麗に整形して返信案を作る）\n${manuals}\n` : ''}
# 知識：教室に通うコース
${readFileSafe(KNOWLEDGE_PATH)}
${visit ? `\n# 知識：出張レッスンコース\n※相手がどちらのコースか分からない時は、決めつけずにどちらのコースかを確認する。\n${visit}` : ''}`;
}

// ---------- 会話ログ ----------
function safeName(userId) { return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_'); }

function logConversation(userId, displayName, direction, text) {
  try {
    const rec = { ts: new Date().toISOString(), userId, displayName, direction, text };
    fs.appendFileSync(path.join(DATA_DIR, `${safeName(userId)}.jsonl`), JSON.stringify(rec) + '\n');
  } catch (e) { console.error('会話の保存に失敗', e); }
}

function loadHistory(userId, maxTurns = 20) {
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, `${safeName(userId)}.jsonl`), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.direction === 'in' || l.direction === 'out'); // 送信済みのみ履歴に
    let msgs = lines.slice(-maxTurns).map((l) => ({ role: l.direction === 'in' ? 'user' : 'assistant', content: l.text }));
    while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += '\n' + m.content;
      else merged.push({ ...m });
    }
    return merged;
  } catch { return []; }
}

// ---------- 保留中の下書き（承認待ち） ----------
function readPendings() { try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return { pendings: {}, last: null }; } }
function writePendings(p) { try { fs.writeFileSync(PENDING_FILE, JSON.stringify(p)); } catch (e) { console.error('pending保存失敗', e); } }
function setPending(cid, data) { const p = readPendings(); p.pendings[cid] = data; p.last = cid; writePendings(p); }
function getPending(cid) { return readPendings().pendings[cid]; }
function getLastPending() { const p = readPendings(); return p.last && p.pendings[p.last] ? { cid: p.last, ...p.pendings[p.last] } : null; }
function clearPending(cid) { const p = readPendings(); delete p.pendings[cid]; if (p.last === cid) p.last = null; writePendings(p); }

// ---------- LINE API ----------
async function getDisplayName(userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (res.ok) return (await res.json()).displayName || null;
  } catch {}
  return null;
}

async function replyToLine(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

async function pushToLine(to, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
}

// 運営者への通知（メッセージ内に[送信][却下]ボタンを表示するFlexメッセージ）
async function notifyOperator(cid, name, customerText, draft, heading) {
  const body = [];
  if (heading) body.push({ type: 'text', text: heading, weight: 'bold', size: 'sm', color: '#1DB446' });
  body.push(
    { type: 'text', text: `${name || '顧客'}さんから`, weight: 'bold', size: 'sm', color: '#888888' },
    { type: 'text', text: `「${customerText}」`, wrap: true, size: 'sm' },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '返信案', weight: 'bold', size: 'sm', margin: 'md' },
    { type: 'text', text: draft || '(返信案の生成に失敗しました)', wrap: true, size: 'sm' },
    { type: 'text', text: '※修正したい時はこのトークに指示を送ってください', wrap: true, size: 'xxs', color: '#aaaaaa', margin: 'md' }
  );
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#1DB446', height: 'sm', action: { type: 'postback', label: '✅ 送信', data: `action=send&cid=${encodeURIComponent(cid)}`, displayText: '送信する' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🗑 却下', data: `action=reject&cid=${encodeURIComponent(cid)}`, displayText: '却下' } },
        ] },
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '✏️ AIで直す', data: `action=revise_ai&cid=${encodeURIComponent(cid)}`, displayText: 'AIで直す' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '✍️ 自分で書く', data: `action=revise_self&cid=${encodeURIComponent(cid)}`, displayText: '自分で書く' } },
        ] },
      ],
    },
  };
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to: OPERATOR_ID, messages: [{ type: 'flex', altText: `${name || '顧客'}さんから問い合わせ`, contents: bubble }] }),
  });
}

// ---------- 運営者メニュー（管理操作） ----------
const OP_STATE_FILE = path.join(BASE_DIR, 'operator-state.json');
function getOpState() { try { return JSON.parse(fs.readFileSync(OP_STATE_FILE, 'utf8')); } catch { return {}; } }
function setOpState(s) { try { fs.writeFileSync(OP_STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('opstate保存失敗', e); } }

function adminBtn(label, data) {
  return { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label, data, displayText: label } };
}

async function pushFlex(to, altText, bubble) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'flex', altText, contents: bubble }] }),
  });
}

async function sendAdminMenu() {
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '管理メニュー', weight: 'bold', size: 'md' }] },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        adminBtn('📤 新規メッセージ', 'menu=new_msg'),
        adminBtn('📢 一斉送信', 'menu=broadcast'),
        adminBtn('📋 応答ルールを見る', 'menu=rules_view'),
        adminBtn('➕ ルールを追加', 'menu=rules_add'),
        adminBtn('📖 規約を見る', 'menu=terms_view'),
        adminBtn('🗒 最近の応答を見る', 'menu=recent'),
      ],
    },
  };
  await pushFlex(OPERATOR_ID, '管理メニュー', bubble);
}

function recentSummary() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl'));
    const recent = files
      .map((f) => ({ f, t: fs.statSync(path.join(DATA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 8);
    const pend = readPendings().pendings;
    const blocks = recent.map(({ f }) => {
      const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const name = lines.map((l) => l.displayName).filter(Boolean).pop() || 'ID:' + f.replace('.jsonl', '').slice(0, 6);
      const cid = lines[0]?.userId;
      const lastIn = [...lines].reverse().find((l) => l.direction === 'in');
      const status = pend[cid] ? ' 【承認待ち】' : '';
      return `▼${name}${status}\n顧客: ${(lastIn?.text || '(発言なし)').slice(0, 60)}`;
    });
    return '【最近のやり取り】\n\n' + (blocks.join('\n\n') || '(なし)');
  } catch { return '履歴がありません。'; }
}

// ---------- こちらから新規/一斉送信 ----------
// 過去にやり取りのある顧客を最近順で返す（運営者自身は除外）
function listCustomers(limit = 10) {
  try {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl'));
    return files
      .map((f) => {
        const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const cid = lines[0]?.userId;
        const name = lines.map((l) => l.displayName).filter(Boolean).pop() || ('ID:' + String(cid).slice(0, 6));
        return { cid, name, mtime: fs.statSync(path.join(DATA_DIR, f)).mtimeMs };
      })
      .filter((c) => c.cid && c.cid !== OPERATOR_ID && c.cid !== 'unknown')
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { return []; }
}

// 全友だちへ一斉送信（LINE broadcast API）
async function broadcastToLine(text) {
  await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ messages: [{ type: 'text', text }] }),
  });
}

// 「新規メッセージ」：相手を1人選ぶ一覧
async function sendNewMsgPicker() {
  const customers = listCustomers(10);
  const contents = customers.length
    ? customers.map((c) => adminBtn(`👤 ${c.name}`, `action=new_to&cid=${encodeURIComponent(c.cid)}&name=${encodeURIComponent(c.name)}`))
    : [{ type: 'text', text: 'やり取りのある顧客がまだいません。', size: 'sm', wrap: true }];
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '📤 新規メッセージ：相手を選ぶ', weight: 'bold', size: 'md', wrap: true }] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents },
  };
  await pushFlex(OPERATOR_ID, '新規メッセージ：相手を選ぶ', bubble);
}

// 「一斉送信」：モード選択（選んで送る / 全員に送る）
async function sendBroadcastModeMenu() {
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '📢 一斉送信', weight: 'bold', size: 'md' }] },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [adminBtn('① 選んで送る', 'bc=select'), adminBtn('② 全員に送る', 'bc=all')],
    },
  };
  await pushFlex(OPERATOR_ID, '一斉送信', bubble);
}

// 「選んで送る」：トグル選択の一覧（押すたびに選択/解除）
async function sendSelectPicker() {
  const st = getOpState();
  const selected = st.selected || [];
  const customers = listCustomers(10);
  const rows = customers.length
    ? customers.map((c) => {
        const on = selected.some((s) => s.cid === c.cid);
        return adminBtn(`${on ? '✅' : '⬜'} ${c.name}`, `bc=toggle&cid=${encodeURIComponent(c.cid)}&name=${encodeURIComponent(c.name)}`);
      })
    : [{ type: 'text', text: '顧客がいません。', size: 'sm' }];
  if (selected.length) rows.push(adminBtn(`▶ ${selected.length}人に本文入力`, 'bc=compose_selected'));
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '送る相手を選ぶ', weight: 'bold', size: 'md' },
      { type: 'text', text: '押すたびに選択/解除', size: 'xxs', color: '#aaaaaa' },
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
  };
  await pushFlex(OPERATOR_ID, '送る相手を選ぶ', bubble);
}

// 送信直前の確認プレビュー（宛先・本文・取消不可警告 + 本当に送る/テスト/キャンセル）
async function sendSendConfirm() {
  const ps = getOpState().pendingSend;
  if (!ps) return;
  let dest;
  if (ps.kind === 'single') dest = `宛先: ${ps.name || '顧客'}さん`;
  else if (ps.kind === 'selected') dest = `宛先: ${ps.recipients.length}人（${ps.recipients.slice(0, 3).map((r) => r.name).join('・')}${ps.recipients.length > 3 ? ' ほか' : ''}）`;
  else dest = '宛先: 全友だち（全員）';
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: '送信内容の確認', weight: 'bold', size: 'md' },
      { type: 'text', text: dest, size: 'sm', color: '#1DB446', wrap: true },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: ps.text, wrap: true, size: 'sm' },
      { type: 'text', text: '⚠️ 送信後は取り消せません', size: 'xs', color: '#dd3333', margin: 'md' },
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#1DB446', height: 'sm', action: { type: 'postback', label: '✅ 本当に送る', data: 'send=now', displayText: '送信' } },
      { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '👤 自分にテスト', data: 'send=test', displayText: 'テスト送信' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🗑 キャンセル', data: 'send=cancel', displayText: 'キャンセル' } },
      ] },
    ] },
  };
  await pushFlex(OPERATOR_ID, '送信内容の確認', bubble);
}

// ---------- レッスン予定（Gカレンダー登録） ----------
// 予約の一時保存（pending.json と同じ要領。bid をキーに段階を保持）
function readBookings() { try { return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8')); } catch { return {}; } }
function writeBookings(b) { try { fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(b)); } catch (e) { console.error('bookings保存失敗', e); } }
function setBooking(bid, data) { const b = readBookings(); b[bid] = data; writeBookings(b); }
function getBooking(bid) { return readBookings()[bid]; }
function clearBooking(bid) { const b = readBookings(); delete b[bid]; writeBookings(b); }
function hasActiveBookingFor(cid) { const b = readBookings(); return Object.values(b).some((x) => x.cid === cid); }
function newBid(cid) { return safeName(cid) + '-' + Date.now(); }

// 表示用「7/30(木) 14:00」
function formatWhen(date, time) {
  try {
    const d = new Date(`${date}T${time || '00:00'}:00+09:00`);
    const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    const md = `${d.getMonth() + 1}/${d.getDate()}(${w})`;
    return time ? `${md} ${time}` : md;
  } catch { return `${date} ${time || ''}`.trim(); }
}

// GASを叩いて予定作成（成功なら'OK ...'が返る）
async function callGasBook({ teacher, title, date, time, durationMin }) {
  if (!GAS_BOOK_URL || !GAS_BOOK_TOKEN) { console.warn('GAS_BOOK_URL/TOKEN 未設定'); return 'ERROR GAS未設定'; }
  const start = `${date}T${time || '00:00'}`;
  const url = `${GAS_BOOK_URL}?token=${encodeURIComponent(GAS_BOOK_TOKEN)}&action=book`
    + `&teacher=${encodeURIComponent(teacher)}&title=${encodeURIComponent(title)}`
    + `&start=${encodeURIComponent(start)}&durationMin=${encodeURIComponent(durationMin || 60)}`;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const t = (await res.text()).trim();
    return t;
  } catch (e) { console.error('GAS book失敗', e); return 'ERROR ' + e.message; }
}

// 私に一声：「生徒に確認を出す？」
async function sendDetectHeadsup(bid, name, whenLabel) {
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: '📅 次回レッスン日を検知', weight: 'bold', size: 'sm', color: '#1DB446' },
      { type: 'text', text: `${name || '顧客'}さんとの会話から`, size: 'sm', color: '#888888' },
      { type: 'text', text: whenLabel, weight: 'bold', size: 'md', wrap: true },
      { type: 'text', text: 'この日時で生徒さんに確認を出しますか？', size: 'sm', wrap: true, margin: 'md' },
    ] },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#1DB446', height: 'sm', action: { type: 'postback', label: '✅ 出す', data: `bk=ask_send&bid=${encodeURIComponent(bid)}`, displayText: '確認を出す' } },
      { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🗑 やめる', data: `bk=ask_cancel&bid=${encodeURIComponent(bid)}`, displayText: 'やめる' } },
    ] },
  };
  await pushFlex(OPERATOR_ID, '次回レッスン日を検知', bubble);
}

// 生徒へ確認：「この日時で合っていますか？」
async function sendStudentDateConfirm(cid, bid, whenLabel) {
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: '次回レッスンのご確認', weight: 'bold', size: 'md' },
      { type: 'text', text: whenLabel, weight: 'bold', size: 'lg', color: '#1DB446', wrap: true },
      { type: 'text', text: 'こちらの日時で合っていますか？', size: 'sm', wrap: true, margin: 'md' },
    ] },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#1DB446', height: 'sm', action: { type: 'postback', label: '✅ はい、OK', data: `ls=ok&bid=${encodeURIComponent(bid)}`, displayText: 'はい、OKです' } },
      { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '違います', data: `ls=no&bid=${encodeURIComponent(bid)}`, displayText: '違います' } },
    ] },
  };
  await pushFlex(cid, '次回レッスンのご確認', bubble);
}

// 私に先生選択：「どの先生のカレンダーに登録？」
async function sendTeacherPicker(bid, name, whenLabel) {
  const rows = TEACHERS.map((t) => adminBtn(`🗓 ${t}先生`, `bk=teacher&bid=${encodeURIComponent(bid)}&teacher=${encodeURIComponent(t)}`));
  rows.push(adminBtn('🗑 やめる', `bk=cancel&bid=${encodeURIComponent(bid)}`));
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: '✅ 生徒さんがOKしました', weight: 'bold', size: 'sm', color: '#1DB446' },
      { type: 'text', text: `${name || '顧客'}さん / ${whenLabel}`, weight: 'bold', size: 'md', wrap: true },
      { type: 'text', text: 'どの先生のカレンダーに登録しますか？', size: 'sm', wrap: true, margin: 'md' },
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
  };
  await pushFlex(OPERATOR_ID, '先生を選んで登録', bubble);
}

// ---------- AI ----------
async function callClaude(messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.warn('ANTHROPIC_API_KEY 未設定'); return null; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: buildSystemPrompt(), messages }),
    });
    if (!res.ok) { console.error('Claude API error', res.status, await res.text()); return null; }
    return (await res.json()).content?.[0]?.text?.trim() || null;
  } catch (e) { console.error('Claude 呼び出し失敗', e); return null; }
}

function generateDraft(userId, userText) {
  const history = loadHistory(userId);
  return callClaude(history.length ? history : [{ role: 'user', content: userText }]);
}

function reviseDraft(pend, instruction) {
  return callClaude([{
    role: 'user',
    content: `顧客(${pend.name || '不明'})からのメッセージ:「${pend.text}」\n\n現在の返信案:\n「${pend.draft}」\n\n運営者からの修正指示:「${instruction}」\n\nこの指示を反映した新しい返信案だけを出力してください（説明は不要）。`,
  }]);
}

// 会話文から「次回レッスン日時」を抽出。曖昧なら found:false。
// 戻り値: { found, date:'YYYY-MM-DD', time:'HH:mm', durationMin, label } | null
async function extractLessonDate(convText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' });
  const system = `あなたは日程抽出器です。会話から「次回レッスンの確定日時」を1つだけ抽出し、JSONのみを返します。
現在日時(日本時間): ${now}
規則:
- 明確な日付と時刻が合意できている時だけ found:true。曖昧（「来週」「そのうち」等、日か時刻が特定できない）なら found:false。
- 相対表現（来週火曜 等）は現在日時から絶対日付に変換する。
- 時刻が無く日付だけの時は time を空文字にして found:true 可。
出力は次のJSONのみ（説明文やコードブロックを付けない）:
{"found":true,"date":"YYYY-MM-DD","time":"HH:mm","durationMin":60,"label":"7/30(木) 14:00"}
または {"found":false}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system, messages: [{ role: 'user', content: convText }] }),
    });
    if (!res.ok) { console.error('抽出API error', res.status); return null; }
    const raw = (await res.json()).content?.[0]?.text?.trim() || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return j.found ? j : { found: false };
  } catch (e) { console.error('抽出失敗', e); return null; }
}

// 日付らしい語を含むかの簡易プレフィルタ（無駄なAPI呼び出しを避ける）
function looksLikeDate(text) {
  return /(\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*[:時]|来週|今週|再来週|月曜|火曜|水曜|木曜|金曜|土曜|日曜|明日|明後日|次回)/.test(text || '');
}

// ---------- 新規登録の案内（オンボーディング） ----------
// 状態は onboarding.json に持つ。stage: mode → profile → terms → check → qa → contract → done
function readOnb() { try { return JSON.parse(fs.readFileSync(ONBOARDING_FILE, 'utf8')); } catch { return {}; } }
function writeOnb(o) { try { fs.writeFileSync(ONBOARDING_FILE, JSON.stringify(o)); } catch (e) { console.error('onboarding保存失敗', e); } }
function getOnb(cid) { return readOnb()[cid] || null; }
function setOnb(cid, data) { const o = readOnb(); o[cid] = data; writeOnb(o); }
function clearOnb(cid) { const o = readOnb(); delete o[cid]; writeOnb(o); }

// 生徒データ（個人情報。VPS内のみに置く）
function saveStudent(cid, data) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8')); } catch {}
  s[cid] = { ...(s[cid] || {}), ...data };
  try { fs.writeFileSync(STUDENTS_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('students保存失敗', e); }
}

// 聞く項目。希望曜日は聞かない（スケジュールは教室・講師の都合で組むため）
const PROFILE_QUESTIONS = [
  { key: 'name', q: 'お名前を、本名のフルネームで教えてください。', hint: '例：山田 太郎' },
  { key: 'kana', q: 'お名前のフリガナを教えてください。', hint: '例：ヤマダ タロウ' },
  { key: 'age', q: '年齢を教えてください。', hint: '数字だけでかまいません（例：34）' },
  { key: 'email', q: 'メールアドレスを教えてください。', hint: '手続きや、大切な連絡に使います' },
  { key: 'phone', q: 'お電話番号を教えてください。', hint: '当日の待ち合わせや、遅れるときの連絡に使います', visitOnly: true },
  { key: 'instrument', q: 'ご希望の楽器を教えてください。', hint: '例：ドラム' },
  { key: 'experience', q: '楽器のご経験を教えてください。', hint: '例：初めてです／3年ほど' },
  { key: 'goal', q: 'レッスンで叶えたいことを教えてください。', hint: '例：好きな曲を叩けるようになりたい' },
];
function questionsFor(mode) { return PROFILE_QUESTIONS.filter((q) => !q.visitOnly || mode === 'visit'); }
function courseLabel(mode) { return mode === 'visit' ? '出張レッスンコース' : '教室に通うコース'; }

// 規約を「## 見出し」ごとの配列にする。原文のまま説明する（要約で規約が歪むのを防ぐ）
function loadTermsSections(mode) {
  const raw = readFileSafe(mode === 'visit' ? KNOWLEDGE_VISIT_PATH : KNOWLEDGE_PATH);
  if (!raw.trim()) return [];
  return raw
    .split(/\n(?=##\s)/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('## '))
    .map((s) => ({ title: s.split('\n')[0].replace(/^##\s*/, '').trim(), body: s }));
}

// 複数メッセージを1回で送る（通知が何度も鳴らないように）
async function pushMulti(to, messages) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
}

function onbBtn(label, data, primary = false) {
  return {
    type: 'button', height: 'sm',
    style: primary ? 'primary' : 'secondary',
    ...(primary ? { color: '#1DB446' } : {}),
    action: { type: 'postback', label: String(label).slice(0, 20), data, displayText: String(label).slice(0, 20) },
  };
}
function restartBtn() {
  return { type: 'button', style: 'link', height: 'sm', action: { type: 'postback', label: '↩ 最初からやり直す', data: 'onb=restart', displayText: '最初からやり直す' } };
}

// 本文（テキスト）＋ボタン（Flex）を1通で送る
async function sendOnbStep(cid, displayName, text, buttons = [], altText = 'ご案内') {
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '下のボタンから進んでください', size: 'xs', color: '#888888', wrap: true }] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [...buttons, restartBtn()] },
  };
  const messages = [];
  if (text) messages.push({ type: 'text', text: String(text).slice(0, 4900) });
  messages.push({ type: 'flex', altText: String(altText).slice(0, 380), contents: bubble });
  await pushMulti(cid, messages);
  if (text) logConversation(cid, displayName, 'out', text);
}

async function startOnboarding(cid, displayName) {
  setOnb(cid, { stage: 'mode', mode: null, profile: {}, profileIdx: 0, termsIdx: 0, checked: [], startedAt: new Date().toISOString() });
  const intro = [
    `はじめまして。${SCHOOL_NAME}で案内を担当している、${BOT_NAME}です。`,
    '',
    'このLINEでは、レッスンの案内、入会の手続き、普段の連絡をしています。',
    '',
    'これから、入会に必要なことを順番に聞いていきます。数分で終わります。',
    '途中で入力を間違えたら、「最初からやり直す」を押せば最初に戻ります。',
  ].join('\n');
  await pushToLine(cid, intro);
  logConversation(cid, displayName, 'out', intro);
  await sendModePicker(cid, displayName);
}

async function restartOnboarding(cid, displayName) {
  clearOnb(cid);
  await pushToLine(cid, '最初からやり直します。');
  await startOnboarding(cid, displayName);
}

async function sendModePicker(cid, displayName) {
  await sendOnbStep(
    cid, displayName,
    [
      'まず、レッスンの受け方を選んでください。',
      '',
      '🏫 教室に通う',
      `　${STUDIO_PLACE}でレッスンを受けます。`,
      '',
      '🚗 出張に来てほしい',
      '　講師が指定の場所へうかがいます。月謝とは別に、出張費と場所代がかかります。',
    ].join('\n'),
    [onbBtn('🏫 教室に通う', 'onb=mode&v=studio', true), onbBtn('🚗 出張に来てほしい', 'onb=mode&v=visit', true)],
    'レッスンの受け方を選んでください',
  );
}

async function askNextProfile(cid, displayName) {
  const st = getOnb(cid);
  if (!st) return;
  const qs = questionsFor(st.mode);
  if (st.profileIdx >= qs.length) { await startTerms(cid, displayName); return; }
  const q = qs[st.profileIdx];
  const text = `【${st.profileIdx + 1}/${qs.length}】${q.q}${q.hint ? `\n${q.hint}` : ''}\n\nこのまま返信してください。`;
  await sendOnbStep(cid, displayName, text, [], q.q);
}

async function acceptProfileAnswer(cid, displayName, text) {
  const st = getOnb(cid);
  const qs = questionsFor(st.mode);
  const q = qs[st.profileIdx];
  if (!q) { await startTerms(cid, displayName); return; }

  if (q.key === 'age') {
    const n = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 120) {
      await pushToLine(cid, '年齢は数字で入力してください（例：34）。');
      return;
    }
    if (n < MIN_AGE) {
      setOnb(cid, { ...st, stage: 'blocked' });
      const msg = [
        'ありがとうございます。',
        '',
        `${SCHOOL_NAME}は、${MIN_AGE}歳以上の方を対象にレッスンを行っています。`,
        '大人としての自立を前提にした内容のため、今の方針では未成年の方はお受けしていません。',
        '',
        'ここまで答えていただいたのに、力になれず残念です。',
        '聞きたいことがあれば、担当からあらためて連絡します。',
      ].join('\n');
      await pushToLine(cid, msg);
      logConversation(cid, displayName, 'out', msg);
      if (OPERATOR_ID) await pushToLine(OPERATOR_ID, `【要対応】${displayName || cid} さんが登録の途中で年齢「${n}歳」と回答したため、ご案内を停止しました。`);
      return;
    }
    st.profile[q.key] = String(n);
  } else if (q.key === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text).trim())) {
      await pushToLine(cid, 'メールアドレスの形式が正しくないようです。もう一度入力してください。');
      return;
    }
    st.profile[q.key] = String(text).trim();
  } else {
    st.profile[q.key] = String(text).trim();
  }

  setOnb(cid, { ...st, stage: 'profile', profileIdx: st.profileIdx + 1 });
  await askNextProfile(cid, displayName);
}

async function startTerms(cid, displayName) {
  const st = getOnb(cid);
  const sections = loadTermsSections(st.mode);
  if (!sections.length) {
    await pushToLine(cid, 'ここまでありがとうございます。規約の説明と手続きの案内は、担当からあらためて連絡します。少し待ってください。');
    if (OPERATOR_ID) await pushToLine(OPERATOR_ID, `【要対応】規約ファイルが読み込めず、${displayName || cid} さんの規約説明を開始できませんでした（${st.mode === 'visit' ? 'knowledge-visit.md' : 'knowledge.md'} を確認してください）。`);
    setOnb(cid, { ...st, stage: 'blocked' });
    return;
  }
  setOnb(cid, { ...st, stage: 'terms', termsIdx: 0 });
  const head = [
    'ありがとうございます。ここからは規約の説明です。',
    '',
    `${courseLabel(st.mode)}の規約を、順番に見ていきます。全部で${sections.length}項目です。`,
    '1つずつ読んで、「次へ」を押してください。',
    '',
    'あとで食い違いが起きないよう、読み飛ばさずに確認してください。',
  ].join('\n');
  await pushToLine(cid, head);
  logConversation(cid, displayName, 'out', head);
  await sendTermsSection(cid, displayName);
}

async function sendTermsSection(cid, displayName) {
  const st = getOnb(cid);
  const sections = loadTermsSections(st.mode);
  const sec = sections[st.termsIdx];
  if (!sec) { await startCheck(cid, displayName); return; }
  const isLast = st.termsIdx >= sections.length - 1;
  const text = `【${st.termsIdx + 1}/${sections.length}】\n\n${sec.body}`;
  await sendOnbStep(cid, displayName, text, [onbBtn(isLast ? '確認へ進む' : '次へ', 'onb=next', true)], `規約 ${st.termsIdx + 1}/${sections.length} ${sec.title}`);
}

async function startCheck(cid, displayName) {
  const st = getOnb(cid);
  setOnb(cid, { ...st, stage: 'check', checked: [] });
  const head = [
    '規約の説明は以上です。',
    '',
    '最後に確認です。下の項目を1つずつ押して、チェックを入れてください。',
    'すべてにチェックが入ると、同意のボタンが出ます。',
    '',
    '納得できない点があれば、同意せずに聞いてください。',
  ].join('\n');
  await pushToLine(cid, head);
  logConversation(cid, displayName, 'out', head);
  await sendCheckList(cid);
}

async function sendCheckList(cid) {
  const st = getOnb(cid);
  const sections = loadTermsSections(st.mode);
  const checked = st.checked || [];
  const rows = sections.map((s, i) => onbBtn(`${checked.includes(i) ? '✅' : '⬜'} ${s.title}`, `onb=chk&i=${i}`));
  const allDone = sections.length > 0 && checked.length === sections.length;
  if (allDone) rows.push(onbBtn('✍️ 上記すべてに同意します', 'onb=agree', true));
  rows.push(restartBtn());
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: '規約の確認', weight: 'bold', size: 'md' },
      { type: 'text', text: `${checked.length} / ${sections.length} 項目を確認しました`, size: 'sm', color: allDone ? '#1DB446' : '#888888', wrap: true },
      { type: 'text', text: '押すたびにチェックが入ります（もう一度押すと外れます）', size: 'xxs', color: '#aaaaaa', wrap: true },
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
  };
  await pushFlex(cid, `規約の確認 ${checked.length}/${sections.length}`, bubble);
}

async function startQa(cid, displayName) {
  const st = getOnb(cid);
  setOnb(cid, { ...st, stage: 'qa' });
  const text = [
    '同意ありがとうございます。',
    '',
    '規約について、わからないことや気になることはありますか。',
    'このまま送ってもらえれば答えます。',
    '',
    '特になければ、下のボタンを押してください。',
  ].join('\n');
  await sendOnbStep(cid, displayName, text, [onbBtn('質問はありません', 'onb=noq', true)], '規約についてご質問はありますか');
}

async function answerTermsQuestion(cid, displayName, text) {
  const st = getOnb(cid);
  const ans = await callClaude([{
    role: 'user',
    content: `相手は「${courseLabel(st.mode)}」で入会を検討している新規の方です。入会前に、規約について質問を受けました。規約を根拠に、簡潔に答えてください。

言葉遣い：丁寧語（です・ます）は保ちつつ、へりくだりすぎない。「お客様」とは呼ばない。過剰な恐縮・謝罪・感謝を重ねない。真摯に、正確に答える。
規約に書かれていないことは断定せず「担当が確認して連絡します」と伝えてください。

質問：${text}`,
  }]);
  const body = ans || 'この点は担当が確認して、あらためて連絡します。';
  await sendOnbStep(cid, displayName, body, [onbBtn('質問はありません', 'onb=noq', true)], 'ご質問へのお答え');
  if (!ans && OPERATOR_ID) await pushToLine(OPERATOR_ID, `【要対応】${displayName || cid} さんの規約質問に自動回答できませんでした。\n質問：${text}`);
}

async function startContract(cid, displayName) {
  const st = getOnb(cid);
  const total = FEE_ENROLL + FEE_MONTHLY;
  const hasFees = FEE_ENROLL > 0 && FEE_MONTHLY > 0;
  const lines = ['ありがとうございます。手続きの案内です。', ''];
  if (hasFees) {
    lines.push(
      `【${courseLabel(st.mode)}／初回のお支払い】（税込）`,
      `・入会金　　　　${FEE_ENROLL.toLocaleString()}円`,
      `・初月のお月謝　${FEE_MONTHLY.toLocaleString()}円`,
      `・合計　　　　　${total.toLocaleString()}円`,
    );
  } else {
    // 料金の設定が読めなかった場合。誤った金額を伝えるより、担当に引き継ぐ
    lines.push('初回の支払いについては、担当からあらためて案内します。');
    console.warn('料金設定が読み込めていません（settings.json を確認してください）');
  }
  if (st.mode === 'visit') {
    lines.push(
      '',
      FEE_VISIT > 0
        ? `※ 出張費（訪問1回につき${FEE_VISIT.toLocaleString()}円）と、出張先の場所代は上記に含まれません。`
        : '※ 出張費と、出張先の場所代は別途かかります。',
      '初回レッスンの日程が決まったら、あらためて案内します。',
    );
  }
  lines.push('', '支払いは、本人名義のクレジットカードでお願いします。');

  const buttons = [];
  if (PAYMENT_LINK_URL) {
    lines.push('下のボタンから手続きに進んでください。');
    buttons.push({ type: 'button', style: 'primary', color: '#1DB446', height: 'sm', action: { type: 'uri', label: '💳 お支払いに進む', uri: PAYMENT_LINK_URL } });
  } else {
    lines.push(
      '',
      '【支払いの手続きについて】',
      'ただいま、オンラインで支払いができる仕組みを準備しています。',
      '整い次第、このLINEで案内しますので、もう少し待ってください。',
    );
  }

  const text = lines.join('\n');
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: PAYMENT_LINK_URL ? '手続きの案内' : '🚧 支払いの手続きは準備中です', weight: 'bold', size: 'md', wrap: true }] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons.length ? buttons : [{ type: 'text', text: '整い次第、このLINEで案内します。', size: 'sm', wrap: true }] },
  };
  await pushMulti(cid, [{ type: 'text', text }, { type: 'flex', altText: 'お手続きのご案内', contents: bubble }]);
  logConversation(cid, displayName, 'out', text);

  const sections = loadTermsSections(st.mode);
  saveStudent(cid, {
    ...st.profile,
    displayName: displayName || '',
    mode: st.mode,
    course: courseLabel(st.mode),
    termsFile: st.mode === 'visit' ? 'knowledge-visit.md' : 'knowledge.md',
    agreedSections: sections.map((s) => s.title),
    agreedAt: new Date().toISOString(),
    startedAt: st.startedAt || '',
  });
  setOnb(cid, { ...st, stage: 'done' });
  await notifyOperatorRegistered(cid, displayName, st, total);
}

async function notifyOperatorRegistered(cid, displayName, st, total) {
  if (!OPERATOR_ID) return;
  const p = st.profile || {};
  const lines = [
    `【新規登録が完了しました】`,
    '',
    `お名前：${p.name || '(未入力)'}（${p.kana || ''}）`,
    `LINE表示名：${displayName || '(取得できず)'}`,
    `コース：${courseLabel(st.mode)}`,
    `年齢：${p.age || ''}歳`,
    `メール：${p.email || ''}`,
  ];
  if (st.mode === 'visit') lines.push(`電話：${p.phone || ''}`);
  lines.push(
    `楽器：${p.instrument || ''}`,
    `経験：${p.experience || ''}`,
    `目標：${p.goal || ''}`,
    '',
    `規約：${courseLabel(st.mode)}の全項目に同意済み`,
    total > 0
      ? `案内した初回の支払い：${total.toLocaleString()}円${st.mode === 'visit' ? '（出張費・場所代は別途）' : ''}`
      : '⚠️ 料金の設定が読めず、金額を案内できませんでした（settings.json を確認してください）',
    PAYMENT_LINK_URL ? '支払いリンクを送信済みです。' : '⚠️ 支払いリンクが未設定のため、金額のみご案内しました。お支払い方法の連絡が必要です。',
  );
  await pushToLine(OPERATOR_ID, lines.join('\n'));
}

// 顧客からのボタン操作
async function handleOnbPostback(cid, displayName, onb, params) {
  if (onb === 'restart') { await restartOnboarding(cid, displayName); return; }
  const st = getOnb(cid);
  if (!st) { await startOnboarding(cid, displayName); return; }

  if (onb === 'mode') {
    const v = params.get('v') === 'visit' ? 'visit' : 'studio';
    setOnb(cid, { ...st, mode: v, stage: 'profile', profileIdx: 0, profile: {} });
    const msg = `${courseLabel(v)}ですね。\nそれでは、いくつか聞かせてください。`;
    await pushToLine(cid, msg);
    logConversation(cid, displayName, 'out', msg);
    await askNextProfile(cid, displayName);
    return;
  }
  if (onb === 'next') {
    if (st.stage !== 'terms') return;
    setOnb(cid, { ...st, termsIdx: st.termsIdx + 1 });
    await sendTermsSection(cid, displayName);
    return;
  }
  if (onb === 'chk') {
    if (st.stage !== 'check') return;
    const i = parseInt(params.get('i'), 10);
    if (!Number.isFinite(i)) return;
    const checked = st.checked || [];
    const at = checked.indexOf(i);
    if (at >= 0) checked.splice(at, 1); else checked.push(i);
    setOnb(cid, { ...st, checked });
    await sendCheckList(cid);
    return;
  }
  if (onb === 'agree') {
    if (st.stage !== 'check') return;
    const sections = loadTermsSections(st.mode);
    if ((st.checked || []).length !== sections.length) { await sendCheckList(cid); return; }
    await startQa(cid, displayName);
    return;
  }
  if (onb === 'noq') {
    if (st.stage !== 'qa') return;
    await startContract(cid, displayName);
    return;
  }
}

// 顧客からのテキスト（オンボーディング進行中）
async function handleOnbText(cid, displayName, text) {
  const t = String(text || '').trim();
  if (/^(最初から|やり直し|やり直す|リセット|やりなおし)$/.test(t)) { await restartOnboarding(cid, displayName); return; }
  const st = getOnb(cid);
  if (!st) return;
  if (st.stage === 'profile') { await acceptProfileAnswer(cid, displayName, t); return; }
  if (st.stage === 'qa') { await answerTermsQuestion(cid, displayName, t); return; }
  if (st.stage === 'blocked') {
    // 案内を止めた相手。運営者が引き取るので、通常の承認フローへ戻す
    return;
  }
  await pushToLine(cid, '下のボタンから進んでください。\n最初からやり直したいときは「最初から」と送ってください。');
}

// ---------- イベント処理 ----------
async function handleEvent(event) {
  // 友だち追加 → 新規登録の案内を始める
  if (event.type === 'follow') {
    const cid = event.source?.userId;
    if (!cid || cid === OPERATOR_ID) return;
    const displayName = await getDisplayName(cid);
    console.log('[follow]', displayName || cid);
    await startOnboarding(cid, displayName);
    return;
  }
  if (event.type === 'unfollow') {
    const cid = event.source?.userId;
    if (cid) clearOnb(cid);
    return;
  }

  // ボタン（承認/却下）
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data || '');
    // 新規登録の案内（顧客が押したボタン）
    const onb = params.get('onb');
    if (onb) {
      const cid = event.source?.userId;
      if (!cid) return;
      const displayName = await getDisplayName(cid);
      console.log('[onboarding]', onb, displayName || cid);
      await handleOnbPostback(cid, displayName, onb, params);
      return;
    }
    // 管理メニュー
    const menu = params.get('menu');
    if (menu) {
      console.log('[admin menu]', menu);
      if (menu === 'rules_view') await pushToLine(OPERATOR_ID, '【応答ルール】\n' + (readFileSafe(RULES_PATH).trim() || '(未設定)'));
      else if (menu === 'terms_view') await pushToLine(OPERATOR_ID, '【規約(知識)】\n' + (readFileSafe(KNOWLEDGE_PATH).slice(0, 4500) || '(未設定)'));
      else if (menu === 'rules_add') { setOpState({ mode: 'awaiting_rule' }); await pushToLine(OPERATOR_ID, '追加するルールを1つ送ってください。'); }
      else if (menu === 'recent') await pushToLine(OPERATOR_ID, recentSummary());
      else if (menu === 'new_msg') await sendNewMsgPicker();
      else if (menu === 'broadcast') await sendBroadcastModeMenu();
      return;
    }

    // 一斉送信フロー（選ぶ/全員/トグル/本文入力へ）
    const bc = params.get('bc');
    if (bc) {
      if (bc === 'select') { setOpState({ mode: 'selecting', selected: [] }); await sendSelectPicker(); }
      else if (bc === 'toggle') {
        const st = getOpState();
        const selected = st.selected || [];
        const tcid = params.get('cid');
        const tname = params.get('name');
        const idx = selected.findIndex((s) => s.cid === tcid);
        if (idx >= 0) selected.splice(idx, 1); else selected.push({ cid: tcid, name: tname });
        setOpState({ mode: 'selecting', selected });
        await sendSelectPicker();
      } else if (bc === 'compose_selected') {
        const selected = getOpState().selected || [];
        if (!selected.length) { await pushToLine(OPERATOR_ID, '相手が選ばれていません。'); return; }
        setOpState({ mode: 'compose_selected', selected });
        await pushToLine(OPERATOR_ID, `${selected.length}人へ送る本文を入力してください。`);
      } else if (bc === 'all') {
        setOpState({ mode: 'compose_bcast' });
        await pushToLine(OPERATOR_ID, '全員へ送る本文を入力してください。');
      }
      return;
    }

    // 送信確認ボタン（本当に送る/テスト/キャンセル）
    const send = params.get('send');
    if (send) {
      const ps = getOpState().pendingSend;
      if (!ps) { await pushToLine(OPERATOR_ID, '送信対象がありません（期限切れかも）。'); return; }
      if (send === 'test') { await pushToLine(OPERATOR_ID, ps.text); await sendSendConfirm(); return; }
      if (send === 'cancel') { setOpState({}); await pushToLine(OPERATOR_ID, '取りやめました。'); return; }
      if (send === 'now') {
        setOpState({}); // 多重送信防止：実行前に即クリア
        if (ps.kind === 'single') {
          await pushToLine(ps.cid, ps.text);
          logConversation(ps.cid, ps.name, 'out', ps.text);
          await pushToLine(OPERATOR_ID, `✅ ${ps.name || '顧客'}さんへ送信しました。`);
        } else if (ps.kind === 'selected') {
          let ok = 0;
          for (const r of ps.recipients) {
            try { await pushToLine(r.cid, ps.text); logConversation(r.cid, r.name, 'out', ps.text); ok++; }
            catch (e) { console.error('一斉(選択)送信失敗', r.cid, e); }
          }
          await pushToLine(OPERATOR_ID, `✅ ${ok}人へ送信しました。`);
        } else if (ps.kind === 'all') {
          await broadcastToLine(ps.text);
          logConversation('broadcast', '(全員一斉)', 'out', ps.text);
          await pushToLine(OPERATOR_ID, '✅ 全員へ一斉送信しました。');
        }
      }
      return;
    }

    // レッスン予定フロー（私側の操作）
    const bk = params.get('bk');
    if (bk) {
      const bid = params.get('bid');
      const bkg = getBooking(bid);
      if (!bkg) { await pushToLine(OPERATOR_ID, '対象の予約が見つかりません（処理済みかも）。'); return; }
      const whenLabel = bkg.label || formatWhen(bkg.date, bkg.time);
      if (bk === 'ask_send') {
        setBooking(bid, { ...bkg, stage: 'student_confirm' });
        await sendStudentDateConfirm(bkg.cid, bid, whenLabel);
        await pushToLine(OPERATOR_ID, `${bkg.name || '生徒'}さんに確認を送りました。返事を待ちます。`);
      } else if (bk === 'ask_cancel') {
        clearBooking(bid);
        await pushToLine(OPERATOR_ID, '🗑 この日程確認は取りやめました。');
      } else if (bk === 'teacher') {
        const teacher = params.get('teacher');
        clearBooking(bid); // 多重登録防止：先にクリア
        const title = `${bkg.name || '生徒'}さん レッスン`;
        const r = await callGasBook({ teacher, title, date: bkg.date, time: bkg.time, durationMin: bkg.durationMin });
        if (r.startsWith('OK')) await pushToLine(OPERATOR_ID, `✅ ${teacher}先生のカレンダーに登録しました（${whenLabel}）。`);
        else await pushToLine(OPERATOR_ID, `❌ 登録に失敗しました：${r}\n（GAS設定/カレンダー書き込み権限を確認してください）`);
      } else if (bk === 'cancel') {
        clearBooking(bid);
        await pushToLine(OPERATOR_ID, '🗑 登録を取りやめました。');
      }
      return;
    }

    // レッスン予定フロー（生徒側のOK/違う）
    const ls = params.get('ls');
    if (ls) {
      const bid = params.get('bid');
      const bkg = getBooking(bid);
      if (!bkg) return; // 期限切れ等は黙って無視
      const whenLabel = bkg.label || formatWhen(bkg.date, bkg.time);
      if (ls === 'ok') {
        await pushToLine(bkg.cid, `${whenLabel} で承りました。ありがとうございます。`);
        logConversation(bkg.cid, bkg.name, 'out', `${whenLabel} で承りました。ありがとうございます。`);
        setBooking(bid, { ...bkg, stage: 'operator_book' });
        await sendTeacherPicker(bid, bkg.name, whenLabel);
      } else if (ls === 'no') {
        await pushToLine(bkg.cid, '承知しました。担当者からあらためてご連絡します。');
        logConversation(bkg.cid, bkg.name, 'out', '承知しました。担当者からあらためてご連絡します。');
        clearBooking(bid);
        await pushToLine(OPERATOR_ID, `↩️ ${bkg.name || '生徒'}さんが日程（${whenLabel}）に「違う」と回答。空き時間を再提示してください。`);
      }
      return;
    }

    const action = params.get('action');
    const cid = params.get('cid');
    const pend = getPending(cid);
    if (action === 'send') {
      if (pend) {
        await pushToLine(cid, pend.draft);
        logConversation(cid, pend.name, 'out', pend.draft);
        clearPending(cid);
        await pushToLine(OPERATOR_ID, `✅ ${pend.name || '顧客'}さんへ送信しました。`);
      } else {
        await pushToLine(OPERATOR_ID, '対象が見つかりませんでした（既に処理済みかも）。');
      }
    } else if (action === 'reject') {
      clearPending(cid);
      await pushToLine(OPERATOR_ID, '🗑 却下しました。');
    } else if (action === 'revise_ai') {
      setOpState({ mode: 'revise_ai', cid });
      await pushToLine(OPERATOR_ID, 'どう直しますか？指示を送ってください（例：もっと丁寧に／料金を明記）。');
    } else if (action === 'revise_self') {
      setOpState({ mode: 'revise_self', cid });
      await pushToLine(OPERATOR_ID, '送る文をそのまま送ってください。その全文がそのまま顧客に送信されます（コピペ・編集OK）。');
    } else if (action === 'new_to') {
      const name = params.get('name');
      setOpState({ mode: 'compose_single', cid, name });
      await pushToLine(OPERATOR_ID, `${name || '顧客'}さんへ送る文を入力してください。`);
    }
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text;
  const userId = event.source?.userId || 'unknown';

  // 運営者本人の発言
  if (userId === OPERATOR_ID) {
    console.log('[operator]', JSON.stringify(text).slice(0, 80));
    const st = getOpState();
    // 新規/一斉送信の本文入力待ち → 確認プレビューを出す
    if (st.mode === 'compose_single' && st.cid) {
      setOpState({ pendingSend: { kind: 'single', cid: st.cid, name: st.name, text } });
      await sendSendConfirm();
      return;
    }
    if (st.mode === 'compose_selected' && st.selected) {
      setOpState({ pendingSend: { kind: 'selected', recipients: st.selected, text } });
      await sendSendConfirm();
      return;
    }
    if (st.mode === 'compose_bcast') {
      setOpState({ pendingSend: { kind: 'all', text } });
      await sendSendConfirm();
      return;
    }
    // ルール追加の入力待ち
    if (st.mode === 'awaiting_rule') {
      try { fs.appendFileSync(RULES_PATH, '\n- ' + text.trim() + '\n'); } catch (e) { console.error(e); }
      setOpState({});
      await pushToLine(OPERATOR_ID, '応答ルールに追加しました。');
      return;
    }
    // 「AIで直す」入力待ち：指示としてAIに作り直させる
    if (st.mode === 'revise_ai' && st.cid) {
      setOpState({});
      const pend = getPending(st.cid);
      if (pend) {
        const revised = await reviseDraft({ name: pend.name, text: pend.text, draft: pend.draft }, text);
        if (revised) { setPending(st.cid, { name: pend.name, text: pend.text, draft: revised }); await notifyOperator(st.cid, pend.name, pend.text, revised, '修正しました'); }
        else await pushToLine(OPERATOR_ID, '修正案の生成に失敗しました。');
      } else await pushToLine(OPERATOR_ID, '対象が見つかりませんでした。');
      return;
    }
    // 「自分で書く」入力待ち：打った全文をそのまま顧客へ送信
    if (st.mode === 'revise_self' && st.cid) {
      setOpState({});
      const pend = getPending(st.cid);
      const name = pend ? pend.name : null;
      await pushToLine(st.cid, text);
      logConversation(st.cid, name, 'out', text);
      clearPending(st.cid);
      await pushToLine(OPERATOR_ID, `✅ ${name || '顧客'}さんへ送信しました。`);
      return;
    }
    // メニューを開く
    if (text.trim() === 'メニュー') { await sendAdminMenu(); return; }
    // 手動トリガー：直近アクティブな顧客の会話から次回レッスン日を検知
    if (text.trim() === '日程確認') {
      const top = listCustomers(1)[0];
      if (!top) { await pushToLine(OPERATOR_ID, '対象の顧客が見つかりません。'); return; }
      if (hasActiveBookingFor(top.cid)) { await pushToLine(OPERATOR_ID, `${top.name}さんは確認が進行中です。`); return; }
      const convText = loadHistory(top.cid, 10).map((m) => `${m.role === 'user' ? '生徒' : '講師/bot'}: ${m.content}`).join('\n');
      const ex = await extractLessonDate(convText);
      if (ex && ex.found) {
        const bid = newBid(top.cid);
        setBooking(bid, { cid: top.cid, name: top.name, date: ex.date, time: ex.time || '', durationMin: ex.durationMin || 60, label: ex.label || formatWhen(ex.date, ex.time), stage: 'headsup' });
        await sendDetectHeadsup(bid, top.name, ex.label || formatWhen(ex.date, ex.time));
      } else {
        await pushToLine(OPERATOR_ID, `${top.name}さんの直近の会話からは、確定した次回日時を読み取れませんでした。`);
      }
      return;
    }
    // 保留中の返信案があれば修正指示として扱う
    const last = getLastPending();
    if (last) {
      const revised = await reviseDraft(last, text);
      if (revised) {
        setPending(last.cid, { name: last.name, text: last.text, draft: revised });
        await notifyOperator(last.cid, last.name, last.text, revised, '修正しました');
      } else {
        await pushToLine(OPERATOR_ID, '修正案の生成に失敗しました。');
      }
      return;
    }
    await pushToLine(OPERATOR_ID, '「メニュー」と送ると管理メニューが開きます。');
    return;
  }

  // 顧客からのメッセージ
  const displayName = await getDisplayName(userId);
  console.log(`incoming from ${displayName || userId}:`, text);
  logConversation(userId, displayName, 'in', text);

  // 新規登録の案内が進行中の相手は、承認フローを通さず自動で進める
  const onbState = getOnb(userId);
  if (onbState && onbState.stage !== 'done' && onbState.stage !== 'blocked') {
    await handleOnbText(userId, displayName, text);
    return;
  }

  const draft = await generateDraft(userId, text);
  logConversation(userId, displayName, 'draft', draft || '');

  if (REPLY_MODE === 'auto') {
    await replyToLine(event.replyToken, draft || '受け付けました。担当者が確認して返信します。');
  } else if (OPERATOR_ID) {
    setPending(userId, { name: displayName, text, draft });
    await notifyOperator(userId, displayName, text, draft, null);
  } else {
    console.warn('OPERATOR_ID 未設定のため通知できません');
  }

  // 次回レッスン日の自動検知 → 私に一声（進行中の予約が無い時だけ）
  if (OPERATOR_ID && looksLikeDate(text) && !hasActiveBookingFor(userId)) {
    try {
      const convText = loadHistory(userId, 10).map((m) => `${m.role === 'user' ? '生徒' : '講師/bot'}: ${m.content}`).join('\n') || `生徒: ${text}`;
      const ex = await extractLessonDate(convText);
      if (ex && ex.found) {
        const bid = newBid(userId);
        setBooking(bid, { cid: userId, name: displayName, date: ex.date, time: ex.time || '', durationMin: ex.durationMin || 60, label: ex.label || formatWhen(ex.date, ex.time), stage: 'headsup' });
        await sendDetectHeadsup(bid, displayName, ex.label || formatWhen(ex.date, ex.time));
      }
    } catch (e) { console.error('日程検知エラー', e); }
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LINE support bot is running');
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  const signature = req.headers['x-line-signature'];
  const expected = crypto.createHmac('SHA256', process.env.LINE_CHANNEL_SECRET || '').update(rawBody).digest('base64');
  if (signature !== expected) { res.writeHead(401); res.end('invalid signature'); return; }

  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { res.writeHead(400); res.end(); return; }

  await Promise.all((body.events || []).map((e) => handleEvent(e).catch((err) => console.error('event error', err))));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => console.log(`LINE support bot listening on ${PORT} (mode=${REPLY_MODE})`));
