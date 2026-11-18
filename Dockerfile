# Bun 1.4.0 added sql.listen(); 1.4.4 fixed onconnect/onclose for its connection, which the listener relies on.
FROM oven/bun:1.4.4-alpine

WORKDIR /app

EXPOSE 80

# bunfig.toml carries the 7-day release-age quarantine, so it must be here before any install.
# No dependencies today; with one, commit bun.lock and copy it here too.
COPY package.json bunfig.toml ./
RUN bun install --production --frozen-lockfile

COPY ./assets/ ./assets/
COPY ./lib/ ./lib/
COPY ./app.js ./app.js

CMD [ "bun", "app.js" ]
