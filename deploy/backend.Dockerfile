# Build from the repository root:
#   docker build -f deploy/backend.Dockerfile -t reasonframe/backend:dev .
#
# The resulting image exposes /usr/local/bin/rf as its entrypoint. Select the
# process with a command: api (default), worker, reconciler, or migrate.

FROM golang:1.26-alpine AS build

ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=$GOPROXY

RUN apk add --no-cache ca-certificates git

WORKDIR /src
COPY backend/ ./backend/

WORKDIR /src/backend
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
    -buildvcs=false \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/rf ./cmd/rf

# Keep SQL migrations alongside the binary for setups where they are not
# embedded with go:embed. The directory is created even when it is absent.
RUN mkdir -p /out/migrations \
    && if [ -d migrations ]; then cp -R migrations/. /out/migrations/; fi

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 rf \
    && adduser -S -u 10001 -G rf -h /app -s /sbin/nologin rf

WORKDIR /app
COPY --from=build /out/rf /usr/local/bin/rf
COPY --from=build /out/migrations /app/migrations

USER 10001:10001
EXPOSE 4310

ENTRYPOINT ["/usr/local/bin/rf"]
CMD ["api"]
