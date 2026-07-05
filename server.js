import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = process.env.PORT || 3000;
// REPLY_MODE:
//   'auto'  … AIの回答をそのまま顧客へ返す（テスト用・今はこれ）
//   'draft' … 顧客には受付返信のみ。AI下書きはログに出す（承認フローを足すまでの安全設定）
const REPLY_MODE = process.env.REPLY_MODE || 'auto';

// 知識ファイルを起動時に読み込む
let KNOWLEDGE = '';
try {
  KNOWLEDGE = fs.readFileSync(new URL('./knowledge.md', import.meta.url), 'utf8');
} catch {
  console.warn('knowledge.md を読めませんでした（空で続行）');
}

const SYSTEM_PROMPT = `あなたはLINEでの顧客対応アシスタントです。下の「知識」だけを根拠に、丁寧語で簡潔に日本語で返信してください。

ルール:
- 知識に書かれていないことは断定せず「担当者が確認のうえご連絡します」と伝える。
- 事実を作らない・盛らない。
- 体験レッスンの案内やよくある質問に、知識の範囲で答える。
- 相手を急かさず、押し付けない丁寧なトーンで。

# 知識
${KNOWLEDGE}`;

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
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!res.ok) {
      console.error('Claude API error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('Claude API 呼び出し失敗', e);
    return null;
  }
}

// 顧客への返信（LINE Reply API）
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
        console.log('incoming message:', text);

        const draft = await generateDraft(text);
        console.log('AI draft:', draft);

        if (draft && REPLY_MODE === 'auto') {
          // テスト用：AIの回答をそのまま返す
          await replyToLine(event.replyToken, draft);
        } else {
          // draftモード or 生成失敗：受付返信のみ（AI回答は顧客に出さない）
          await replyToLine(
            event.replyToken,
            '受け付けました。担当者が確認して返信しますので、少々お待ちください。'
          );
        }
      }
    })
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => console.log(`LINE support bot listening on ${PORT} (mode=${REPLY_MODE})`));
