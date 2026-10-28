FROM node:24-alpine3.23 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
RUN npm run build
WORKDIR /app/admin
COPY admin/package*.json ./
RUN npm ci
COPY admin ./
RUN npm run build

FROM node:24-alpine3.23
RUN apk add --no-cache postgresql17-client
ENV PATH="/usr/libexec/postgresql17:${PATH}"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/sql ./sql
COPY --from=build /app/admin/dist ./admin/dist
CMD ["node","dist/server.js"]
