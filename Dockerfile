FROM node:22-alpine

WORKDIR /app

EXPOSE 80

COPY package*.json ./

RUN npm ci --omit=dev

COPY ./assets/ ./assets/
COPY ./app.js ./app.js
COPY ./index.ejs ./index.ejs

CMD [ "node", "." ]