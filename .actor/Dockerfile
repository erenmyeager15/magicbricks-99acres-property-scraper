FROM apify/actor-node:24

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --include=dev

COPY . ./
RUN npm run build && npm prune --omit=dev

CMD ["npm", "start"]
