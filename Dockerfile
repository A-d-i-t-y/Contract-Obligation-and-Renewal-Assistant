FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/data/db.json PORT=3000
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || true
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node","server.js"]
