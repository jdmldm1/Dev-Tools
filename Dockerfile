

FROM --platform=$BUILDPLATFORM golang:alpine AS build
ARG TARGETOS=linux
ARG TARGETARCH
RUN apk add --no-cache upx zopfli
RUN GOBIN=/usr/local/bin go install github.com/evanw/esbuild/cmd/esbuild@v0.25.10
WORKDIR /src
COPY docker/server/ ./
COPY index.html all.html toolbox.html catalog.js manifest.json sw.js www/
COPY assets/ www/assets/
COPY sheets/ www/sheets/
# Minify scripts and styles in place (no bundling, so top-level names survive), then compress with zopfli.
RUN find www -name '*.js' ! -name '*.min.js' -exec esbuild --minify --log-level=warning --allow-overwrite --outfile={} {} \;  && find www -name '*.css' -exec esbuild --minify --log-level=warning --allow-overwrite --outfile={} {} \;
RUN find www -type f -exec zopfli --i30 {} \; -exec rm {} \;
RUN go vet ./... && go test ./...
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false -tags netgo,osusergo -ldflags="-s -w -buildid=" -o /out/dev-tools . \
 && (upx --ultra-brute --lzma -q /out/dev-tools >/dev/null || echo "upx skipped")

FROM scratch
COPY --from=build /out/dev-tools /dev-tools
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=2s CMD ["/dev-tools", "-healthcheck"]
ENTRYPOINT ["/dev-tools"]
