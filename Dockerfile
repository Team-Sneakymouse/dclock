FROM node:alpine

WORKDIR /app

EXPOSE 80

COPY package*.json ./

RUN npm ci --only-production

COPY ./assets/ ./assets/
COPY ./app.js ./app.js
COPY ./index.ejs ./index.ejs

CMD [ "node", "." ]