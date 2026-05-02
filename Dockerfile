FROM apify/actor-node-playwright-chrome:24-1.59.1

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD npm start --silent
