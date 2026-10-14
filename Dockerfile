FROM node:22-alpine

# Chromium renders the PDF export; the fonts keep the output readable.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont font-liberation font-noto

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
