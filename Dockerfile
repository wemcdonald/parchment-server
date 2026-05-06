FROM node:20-alpine AS parchment-builder
RUN apk add --no-cache git python3 make g++ bash patch
WORKDIR /src
RUN git clone --depth=1 --recurse-submodules --shallow-submodules https://github.com/curiousdannii/parchment.git .
COPY frontend/zvm-shim.js /tmp/work/zvm-shim.js
COPY patches/ /tmp/work/patches/
RUN cp /tmp/work/zvm-shim.js src/common/zvm.js \
 && patch -p1 < /tmp/work/patches/parchment-build-js.patch \
 && patch -p1 < /tmp/work/patches/parchment-launcher-ts.patch \
 && patch -p1 < /tmp/work/patches/parchment-formats-ts.patch \
 && patch -p1 < /tmp/work/patches/parchment-glkapi-ts.patch \
 && patch -p1 < /tmp/work/patches/parchment-zvm-runtime-js.patch \
 && patch -p1 < /tmp/work/patches/parchment-zvm-io-js.patch
RUN npm install && ./build.js tools web

FROM golang:1.23-alpine AS saves-builder
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o /out/parchment-saves .

FROM nginx:alpine
# Parchment web launcher static assets — lives under /public/, served without auth at the reverse proxy.
COPY --from=parchment-builder /src/dist/web/ /usr/share/nginx/html/public/
COPY --from=parchment-builder /src/dist/fonts/ /usr/share/nginx/html/public/fonts/
COPY frontend/http-provider.js /usr/share/nginx/html/public/shim/http-provider.js
COPY frontend/sync-dialog.js /usr/share/nginx/html/public/shim/sync-dialog.js
COPY play.html /usr/share/nginx/html/play.html
COPY examples/index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=saves-builder /out/parchment-saves /usr/local/bin/parchment-saves
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/api/saves/health && wget -q -O /dev/null http://127.0.0.1/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
