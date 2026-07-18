FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

ENV PORT=3000

EXPOSE 3000

CMD ["node", "build"]
