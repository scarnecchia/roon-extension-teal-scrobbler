FROM docker.io/library/node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

CMD ["node", "src/index.js"]
