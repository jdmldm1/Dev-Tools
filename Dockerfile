

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS=linux
ARG TARGETARCH
RUN apk add --no-cache upx
WORKDIR /src
COPY docker/server/ ./
COPY index.html all.html toolbox.html catalog.js www/
COPY assets/ www/assets/
COPY sheets/ www/sheets/
RUN find www -type f -exec gzip -9n {} +
RUN go vet ./... && go test ./...
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/dev-tools . \
 && (upx --best --lzma -q /out/dev-tools >/dev/null || echo "upx skipped")

FROM scratch
COPY --from=build /out/dev-tools /dev-tools
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=2s CMD ["/dev-tools", "-healthcheck"]
ENTRYPOINT ["/dev-tools"]
