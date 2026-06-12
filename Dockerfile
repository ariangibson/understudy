FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
# --ignore-scripts: the prepare hook runs tsc, but src/ isn't copied yet
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- "http://localhost:${PORT:-3001}/health" || exit 1
CMD ["node", "dist/index.js"]
