# No browser needed: we call Ring's JSON API directly, so a tiny Node image
# is all we need (this used to be a ~1GB Puppeteer/Chromium image).
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Cloud Run Jobs just run the container to completion; no server/port needed.
CMD ["node", "scrape.js"]
