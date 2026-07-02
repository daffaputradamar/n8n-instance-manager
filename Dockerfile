FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV MANAGER_PORT=5600
EXPOSE 5600

CMD ["node", "server.js"]
