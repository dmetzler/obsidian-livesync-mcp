FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY lib ./lib
RUN npm ci --ignore-scripts

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY types ./types
RUN npm run build

FROM node:22-alpine AS production

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_PORT=3100

EXPOSE 3100

USER node

CMD ["node", "dist/index.cjs"]
