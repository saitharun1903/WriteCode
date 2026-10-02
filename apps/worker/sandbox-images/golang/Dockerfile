# Go with its standard library already compiled. In a sandbox with one CPU, no
# network and little memory, a program then builds in about a second instead of
# ten, and the compiler has nothing to write but the program itself (the cache
# is read-only, like the rest of the image).
FROM golang:1.25-alpine
ENV GOCACHE=/opt/gocache GOFLAGS=-buildvcs=false CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GO111MODULE=off
RUN go build std && chmod -R a+rX /opt/gocache
