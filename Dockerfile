FROM apify/actor-node-playwright-chrome:22-1.60.0

COPY --chown=myuser package*.json Dockerfile check-playwright-version.mjs ./

RUN node check-playwright-version.mjs

RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && rm -r ~/.npm

COPY --chown=myuser . ./

CMD npm start --silent
