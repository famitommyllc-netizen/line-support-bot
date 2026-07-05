import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 3000;
// REPLY_MODE: 'auto' … AI回答を顧客へ返す / 'draft' … 受付返信のみ（承認フロー用）
const REPLY_MODE = process.env.REPLY_MODE || 'auto';

// 知識ファイルのパス（VPSマウントの非公開ファイル）
const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH || new URL('./knowledge.md', import.meta.url).pathname;
// 会話の保存先（既存マウント配下＝VPSに永続化。追加マウント不要）
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(KNOWLEDGE_PATH), 'conversations');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('conversation data dir:', DATA_DIR);
} catch (e) {
  console.warn('DATA_DIR 作成に失敗', e);
}

// ① 自動リロード：知識はメッセージごとに読み直す（編集したら再起動なしで反映）
function readKnowledge() {
  try {
    return fs.readFileSync(KNOWLEDGE_PATH, 'utf8');
  } catch {
    console.warn('knowledge を読めませんでした', String(KNOWLEDGE_PATH));
    return '';
  }
}

function buildSystemPrompt() {
  return `あなたはLINEでの顧客対応アシスタントです。下の「知識」だけを根拠に、丁寧語で簡潔に日本語で返信してください。

ルール:
- 知識に書かれていないことは断定せず「担当者が確認のうえご連絡します」と伝える。
- 事実を作らない・盛らない。
- 体験レッスンの案内やよくある質問に、知識の範囲で答える。
- 相手を急かさず、押し付けない丁寧なトーンで。
- LINEでは太字などの記号（**）は表示されないので使わない。

# 知識
${readKnowledge()}`;
}

// ② 会話を人ごとに保存（JSONL）
function logConversation(userId, displayName, direction, text) {
  try {
    const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const rec = { ts: new Date().toISOString(), userId, displayName, direction, text };
    fs.appendFileSync(path.join(DATA_DIR, `${safe}.jsonl`), JSON.stringify(rec) + '\n');
  } catch (e) {
    console.error('会話の保存に失敗', e);
  }
}

// 顧客の表示名を取得（ベストエフォート）
async function getDisplayName(userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (res.ok) return (await res.json()).displayName || null;
  } catch {}
  return null;
}

// Claude(Haiku) で下書きを生成
async function generateDraft(userText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('ANTHROPIC_API_KEY 未設定のため下書き生成をスキップ');
    return null;
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!res.ok) {
      console.error('Claude API error', res.status, await res.text());
      return null;
    }
    return (await res.json()).content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('Claude API 呼び出し失敗', e);
    return null;
  }
}

async function replyToLine(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LINE support bot is running');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  const signature = req.headers['x-line-signature'];
  const expected = crypto
    .createHmac('SHA256', process.env.LINE_CHANNEL_SECRET || '')
    .update(rawBody)
    .digest('base64');
  if (signature !== expected) {
    res.writeHead(401);
    res.end('invalid signature');
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  const events = body.events || [];
  await Promise.all(
    events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;
        const userId = event.source?.userId || 'unknown';
        const displayName = await getDisplayName(userId);
        console.log(`incoming from ${displayName || userId}:`, text);
        logConversation(userId, displayName, 'in', text);

        const draft = await generateDraft(text);
        const reply =
          draft && REPLY_MODE === 'auto'
            ? draft
            : '受け付けました。担当者が確認して返信しますので、少々お待ちください。';
        await replyToLine(event.replyToken, reply);
        logConversation(userId, displayName, 'out', reply);
      }
    })
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => console.log(`LINE support bot listening on ${PORT} (mode=${REPLY_MODE})`));
