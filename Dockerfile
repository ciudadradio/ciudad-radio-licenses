FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY . .
RUN mkdir -p data
EXPOSE 3900
ENV NODE_ENV=production
CMD ["node", "license-server.mjs"]
