// 顧客ごとの会話履歴を要約する（cronから定期実行）
// 実行例: docker exec <container> node summarize.js
import fs from 'node:fs';
import path from 'node:path';

const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH || new URL('./knowledge.md', import.meta.url).pathname;
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(KNOWLEDGE_PATH), 'conversations');
const SUMMARY_DIR = process.env.SUMMARY_DIR || path.join(path.dirname(KNOWLEDGE_PATH), 'summaries');
fs.mkdirSync(SUMMARY_DIR, { recursive: true });

const NOTE_HEADER = '## あなたの方針メモ（手動で追記）';

async function summarizeOne(transcript, name) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `次の顧客対応履歴を分析し、日本語で簡潔にまとめてください。以下の3点を箇条書きで：
1. この顧客の傾向
2. 繰り返している質問・論点（例：規約の件を何度も聞く 等。あれば具体的に）
3. 今後の対応方針の案（例：次回は先に規約を案内する、釘を刺す 等）
事実に基づき、憶測は控えめに。`,
      messages: [{ role: 'user', content: `顧客名: ${name}\n\n=== 履歴 ===\n${transcript}` }],
    }),
  });
  if (!res.ok) return `要約失敗: ${res.status} ${await res.text()}`;
  return (await res.json()).content?.[0]?.text?.trim() || '';
}

const files = fs.existsSync(DATA_DIR)
  ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl'))
  : [];

for (const f of files) {
  const lines = fs
    .readFileSync(path.join(DATA_DIR, f), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  if (!lines.length) continue;

  const name = lines.map((l) => l.displayName).filter(Boolean).pop() || lines[0].userId;
  const transcript = lines.map((l) => `${l.direction === 'in' ? '顧客' : 'bot'}: ${l.text}`).join('\n');
  const summary = await summarizeOne(transcript, name);

  const outPath = path.join(SUMMARY_DIR, f.replace('.jsonl', '.md'));
  // 既存の「方針メモ」は残す
  let notes = '';
  if (fs.existsSync(outPath)) {
    const prev = fs.readFileSync(outPath, 'utf8');
    const idx = prev.indexOf(NOTE_HEADER);
    if (idx >= 0) notes = prev.slice(idx + NOTE_HEADER.length).trim();
  }

  const body = `# ${name} の要約\n\n更新: ${new Date().toISOString()}\n\n${summary}\n\n---\n${NOTE_HEADER}\n${notes}\n`;
  fs.writeFileSync(outPath, body);
  console.log('summarized:', name);
}

console.log('done:', files.length, 'customers');
