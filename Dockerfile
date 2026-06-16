FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 3100
ENV MCP_TRANSPORT=sse MCP_PORT=3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1
ENTRYPOINT ["node", "dist/index.cjs"]
