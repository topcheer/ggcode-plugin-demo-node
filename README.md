# GGCode gRPC Plugin Demo — Node.js

A reference implementation of a [ggcode](https://github.com/topcheer/ggcode) gRPC plugin written in Node.js / TypeScript.

## What It Provides

| Tool | Description |
|------|-------------|
| `base64_encode` | Encode a UTF-8 string to Base64 |
| `base64_decode` | Decode a Base64 string to UTF-8 |
| `hash` | Compute SHA-256 hash of a string (hex digest) |

## Prerequisites

- Node.js 18+
- npm

## Setup

```bash
git clone https://github.com/topcheer/ggcode-plugin-demo-node.git
cd ggcode-plugin-demo-node
npm install
npm run build
```

## Install

```bash
ggcode plugin install crypto-tools node $(pwd)/dist/plugin.js

# Verify
ggcode plugin list
```

Restart ggcode. The agent can now call `base64_encode`, `base64_decode`, and `hash`.

## Config Equivalent

```yaml
plugins:
  - name: crypto-tools
    type: grpc
    command:
      - node
      - /path/to/dist/plugin.js
```

## How It Works

```
User → ggcode agent → tool call → gRPC (Unix socket) → this Node.js plugin → result
```

The plugin runs as a **subprocess** managed by ggcode. It uses raw protobuf wire
format encoding (no protoc-generated code needed), keeping the demo self-contained.

### Startup Sequence

1. ggcode sets `GGCODE_PLUGIN=ggcode-grpc-plugin-v1` in the environment
2. This plugin verifies the magic cookie
3. Creates a Unix domain socket in a temp directory
4. Prints the go-plugin handshake line to stdout:
   ```
   1|1|unix|/tmp/ggcode-plugin-XXXXX/plugin.sock|grpc|
   ```
   Format: `core_version|app_version|network|socket_path|protocol|cert`
5. Starts a gRPC server on the socket with `ToolService` + health check
6. ggcode connects, calls `ListTools()`, then `Execute()` as needed

## Uninstall

```bash
ggcode plugin uninstall crypto-tools
```

## License

MIT
