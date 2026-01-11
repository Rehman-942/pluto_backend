# syntax=docker/dockerfile:1

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN yarn install --production
COPY . .
CMD ["node", "server.js"]
EXPOSE 5000