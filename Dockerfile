# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node Server/package.json Server/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node Server/src ./src
COPY --chown=node:node Server/public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 ALLOW_DEV_GUESTS=false
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
