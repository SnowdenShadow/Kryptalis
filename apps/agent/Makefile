.PHONY: build build-linux build-all run clean lint

build:
	go build -o bin/agent ./cmd/agent

# Cross-compile static linux binaries (what install.sh fetches).
build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/kryptalis-agent-linux-amd64 ./cmd/agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o bin/kryptalis-agent-linux-arm64 ./cmd/agent

build-all: build build-linux

run:
	go run ./cmd/agent

clean:
	rm -rf bin/

lint:
	golangci-lint run ./...
