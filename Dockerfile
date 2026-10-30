FROM node:24-alpine
RUN npm install -g supergateway@4.2.1 @modelcontextprotocol/server-filesystem@2.1.0
WORKDIR /app
COPY gateway.mjs /app/gateway.mjs
EXPOSE 8080
CMD ["node", "/app/gateway.mjs"]
