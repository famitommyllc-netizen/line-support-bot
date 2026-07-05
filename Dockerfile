# 依存ゼロの小さなNodeアプリ（メモリ節約のため alpine + 最小構成）
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
