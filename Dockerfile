FROM apify/actor-node-playwright-chrome:22

COPY --chown=myuser package*.json Dockerfile ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && rm -r ~/.npm

COPY --chown=myuser . ./

CMD npm start --silent
