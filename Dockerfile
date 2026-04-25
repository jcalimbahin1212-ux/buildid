# Multi-stage build for the BuildID signaling server.
FROM node:20-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/src ./src
COPY server/public ./public
EXPOSE 8080
CMD ["node", "src/index.js"]
