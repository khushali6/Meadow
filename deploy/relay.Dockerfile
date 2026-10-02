# Meadow Telegram relay. Build from the repo root:
#   pnpm build && docker build -f deploy/relay.Dockerfile -t meadow-relay .
#   docker run -e TELEGRAM_BOT_TOKEN=... -p 8787:8787 -v meadow-relay:/data meadow-relay
# Put it behind HTTPS (your platform's TLS, Caddy, or a load balancer).
FROM node:22-alpine
WORKDIR /app
COPY dist/relay.js ./relay.js
ENV PORT=8787 HOST=0.0.0.0 RELAY_DATA=/data/devices.json
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "relay.js"]
