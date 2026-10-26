# One image for both: the website imports the bot's code from ../gambling-bot/src.
FROM node:22-alpine
WORKDIR /app
COPY gambling-bot/package*.json gambling-bot/
RUN cd gambling-bot && npm ci --omit=dev
COPY gambling-bot gambling-bot
COPY gambling-website-bot gambling-website-bot
ENV DATABASE_PATH=/data/bot.db
USER node
