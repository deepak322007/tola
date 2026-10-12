FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /var/lib/tola && chown -R node:node /var/lib/tola

ENV NODE_ENV=production
ENV PORT=3000
ENV TOLA_DB_PATH=/var/lib/tola/tola.sqlite

VOLUME ["/var/lib/tola"]
EXPOSE 3000
USER node
CMD ["npm", "start"]
