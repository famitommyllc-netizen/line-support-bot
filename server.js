import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 3000;

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
  // 動作確認用
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

  // 生の本文を読む（署名検証に必要）
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  // 署名検証：本当にLINEから来たか
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
        console.log('incoming message:', event.message.text);
        // 顧客へは自動受付返信だけ（AI回答はまだ出さない＝下書き承認式の第一歩）
        await replyToLine(
          event.replyToken,
          '受け付けました。担当者が確認して返信しますので、少々お待ちください。'
        );
      }
    })
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => console.log(`LINE support bot listening on ${PORT}`));
