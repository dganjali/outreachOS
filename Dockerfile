# Cloud Run image for the OutreachOS API.
# The React frontend is built separately and hosted on Vercel — this image
# only serves /api/* + /healthz.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.server.json ./
COPY shared ./shared
COPY api ./api
COPY server ./server
RUN npm run server:build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/shared ./shared

# Cloud Run sets $PORT.
EXPOSE 8080
CMD ["node", "dist-server/server.cjs"]
