# DAYA Gateway — multi-stage build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY packages packages
RUN npm run build:gateway

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY packages/gateway/package.json ./packages/gateway/package.json
# Core is a dependency of the gateway; install only runtime deps of the workspace.
RUN npm install --omit=dev --prefix packages/gateway --no-package-lock

EXPOSE 8787
ENV GATEWAY_PORT=8787
CMD ["node", "packages/gateway/dist/index.js"]
