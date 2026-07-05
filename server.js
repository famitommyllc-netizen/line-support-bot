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
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'conversations');
const PENDING_FILE = path.join(BASE_DIR, 'pending.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// 運営者（あなた）のLINE userId
const OPERATOR_ID =
  process.env.OPERATOR_USER_ID ||
  (() => { try { return fs.readFileSync(path.join(BASE_DIR, 'operator.txt'), 'utf8').trim(); } catch { return ''; } })();
console.log(`mode=${REPLY_MODE} operator=${OPERATOR_ID ? 'set' : 'MISSING'}`);

// ---------- 知識・ルール ----------
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function buildSystemPrompt() {
  const rules = readFileSafe(RULES_PATH).trim();
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' });
  return `あなたはLINEでの顧客対応アシスタントです。下の「知識」だけを根拠に、丁寧語で簡潔に日本語で返信してください。

現在日時（日本時間）: ${now}
※退会の最短時期などは、この現在日時と規約の期限ルールから計算して具体的に案内してください。

基本ルール:
- 知識に書かれていないことは断定せず「担当者が確認のうえご連絡します」と伝える。
- 事実を作らない・盛らない。
- 相手を急かさず、押し付けない丁寧なトーンで。
- LINEでは太字などの記号（**）は表示されないので使わない。
${rules ? `\n# 追加の回答ルール（運用者が定義）\n${rules}\n` : ''}
# 知識
${readFileSafe(KNOWLEDGE_PATH)}`;
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

// 運営者への通知（[送信][却下]ボタン付き）
async function notifyOperator(text, cid) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({
      to: OPERATOR_ID,
      messages: [{
        type: 'text',
        text,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '✅ 送信する', data: `action=send&cid=${encodeURIComponent(cid)}`, displayText: '送信する' } },
            { type: 'action', action: { type: 'postback', label: '🗑 却下', data: `action=reject&cid=${encodeURIComponent(cid)}`, displayText: '却下' } },
          ],
        },
      }],
    }),
  });
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

// ---------- イベント処理 ----------
async function handleEvent(event) {
  // ボタン（承認/却下）
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data || '');
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
    }
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text;
  const userId = event.source?.userId || 'unknown';

  // 運営者本人の発言＝保留中の下書きへの「修正指示」
  if (userId === OPERATOR_ID) {
    const last = getLastPending();
    if (last) {
      const revised = await reviseDraft(last, text);
      if (revised) {
        setPending(last.cid, { name: last.name, text: last.text, draft: revised });
        await notifyOperator(`修正しました：\n———\n${revised}`, last.cid);
      } else {
        await pushToLine(OPERATOR_ID, '修正案の生成に失敗しました。');
      }
    }
    return;
  }

  // 顧客からのメッセージ
  const displayName = await getDisplayName(userId);
  console.log(`incoming from ${displayName || userId}:`, text);
  logConversation(userId, displayName, 'in', text);

  const draft = await generateDraft(userId, text);
  logConversation(userId, displayName, 'draft', draft || '');

  if (REPLY_MODE === 'auto') {
    await replyToLine(event.replyToken, draft || '受け付けました。担当者が確認して返信します。');
  } else if (OPERATOR_ID) {
    setPending(userId, { name: displayName, text, draft });
    const notif = `${displayName || '顧客'}さんから届いています：\n「${text}」\n\nこう返そうと思いますが、いかがですか？\n———\n${draft || '(返信案の生成に失敗しました)'}`;
    await notifyOperator(notif, userId);
  } else {
    console.warn('OPERATOR_ID 未設定のため通知できません');
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
