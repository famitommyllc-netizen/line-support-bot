# LINE 顧客対応bot

顧客の質問 → AIが下書き → あなたが承認して送信、の形の顧客対応bot。

## 対応する内容
1. 体験レッスン案内のやり取り（自動化候補）
2. よくある質問対応（自動化候補）
3. 規約違反者への規約ベースのマニュアル対応（下書き承認）

※最初は全部「下書き→あなたが確認して送信」で運用。慣れたら1・2を自動へ。

## 構成
- LINE公式 + Messaging API（受信・送信）
- 小さなサーバー（webhook）
- Claude API（Haiku）で下書き生成
- 知識ベース：FAQ・規約・レッスン情報

## 想定コスト
- 問い合わせ 月10通未満 → API実コストは月数円（スペンドリミット内）

## 進捗
- [x] プロジェクトフォルダ作成
- [x] LINE Messaging API チャンネル（作成済み）
- [ ] Channel access token / Channel secret を控える
- [ ] webhook サーバー用意
- [ ] Claude API 接続 + 知識読み込み
- [ ] 下書き→承認→送信フロー
- [ ] テスト送信
- [ ] 本番公開

## 鍵の置き場所
- Anthropic APIキー: ~/Documents/API/anthropic-api-key.txt
- LINE の鍵: （このフォルダ内の .env に置く予定・後で作成）
