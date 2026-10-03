# Go with Delve, for the debugger and the visualizer. Like the Go image, the
# standard library is compiled once here and the cache is read-only; Python
# runs the scripts that drive Delve.
FROM golang:1.25-alpine
ENV GOCACHE=/opt/gocache GOFLAGS=-buildvcs=false CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GO111MODULE=off
RUN apk add --no-cache python3 \
 && GOPROXY=https://proxy.golang.org GO111MODULE=on GOFLAGS= GOCACHE=/tmp/dlv-cache GOPATH=/tmp/dlv-path go install github.com/go-delve/delve/cmd/dlv@v1.25.2 \
 && mv /tmp/dlv-path/bin/dlv /usr/local/bin/dlv \
 && rm -rf /tmp/dlv-cache /tmp/dlv-path \
 && go build std && chmod -R a+rX /opt/gocache
