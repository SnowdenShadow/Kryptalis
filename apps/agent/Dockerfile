FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY apps/agent/go.mod apps/agent/go.sum ./
RUN go mod download
COPY apps/agent/ .
RUN CGO_ENABLED=0 GOOS=linux go build -o /agent ./cmd/agent

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /agent /usr/local/bin/agent
ENTRYPOINT ["agent"]
