# syntax=docker/dockerfile:1.7

FROM golang:1.25-alpine AS certspotter-builder

RUN CGO_ENABLED=0 go install software.sslmate.com/src/certspotter/cmd/certspotter@v0.24.2

FROM node:22-alpine

RUN apk add --no-cache ca-certificates tini

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=certspotter-builder /go/bin/certspotter /usr/local/bin/certspotter

RUN mkdir -p /data && chmod 0755 /app/src/certspotter-hook.js

ENV NODE_ENV=production \
    DATA_DIR=/data
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
