// GGCode gRPC Plugin Demo (Node.js)
//
// Provides three tools:
//   - base64_encode: Encode a string to Base64
//   - base64_decode: Decode a Base64 string
//   - hash:          Compute SHA-256 hash of a string
//
// This implementation uses raw protobuf wire format to avoid needing
// protoc-generated code, keeping the demo self-contained.

import * as grpc from "@grpc/grpc-js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// --- Constants (must match host) ---
const MAGIC_COOKIE_KEY = "GGCODE_PLUGIN";
const MAGIC_COOKIE_VALUE = "ggcode-grpc-plugin-v1";
const CORE_PROTOCOL_VERSION = 1;
const APP_PROTOCOL_VERSION = 1;

// --- Protobuf wire format helpers ---

function encodeVarint(n: number): Buffer {
    const bytes: number[] = [];
    while (n > 0x7f) {
        bytes.push((n & 0x7f) | 0x80);
        n >>>= 7;
    }
    bytes.push(n & 0x7f);
    return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNum: number, data: Buffer): Buffer {
    const tag = encodeVarint((fieldNum << 3) | 2);
    const len = encodeVarint(data.length);
    return Buffer.concat([tag, len, data]);
}

function encodeString(fieldNum: number, str: string): Buffer {
    return encodeLengthDelimited(fieldNum, Buffer.from(str, "utf-8"));
}

function encodeBool(fieldNum: number, val: boolean): Buffer {
    const tag = encodeVarint((fieldNum << 3) | 0);
    return Buffer.concat([tag, Buffer.from([val ? 1 : 0])]);
}

function readVarint(buf: Buffer, offset: number): { value: number; newOffset: number } {
    let result = 0;
    let shift = 0;
    while (offset < buf.length) {
        const byte = buf[offset];
        offset++;
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, newOffset: offset };
}

// --- Tool definitions ---

interface ExecuteResult {
    content: string;
    is_error?: boolean;
}

const TOOLS = [
    {
        name: "base64_encode",
        description: "Encode a UTF-8 string to Base64",
        parameters: JSON.stringify({
            type: "object",
            properties: {
                input: { type: "string", description: "String to encode" },
            },
            required: ["input"],
        }),
        categories: ["encoding", "demo"],
    },
    {
        name: "base64_decode",
        description: "Decode a Base64 string to UTF-8",
        parameters: JSON.stringify({
            type: "object",
            properties: {
                input: { type: "string", description: "Base64 string to decode" },
            },
            required: ["input"],
        }),
        categories: ["encoding", "demo"],
    },
    {
        name: "hash",
        description: "Compute SHA-256 hash of a string, returns hex digest",
        parameters: JSON.stringify({
            type: "object",
            properties: {
                input: { type: "string", description: "String to hash" },
            },
            required: ["input"],
        }),
        categories: ["crypto", "demo"],
    },
];

function executeTool(toolName: string, inputBuf: Buffer): ExecuteResult {
    let input: any = {};
    if (inputBuf.length > 0) {
        try {
            input = JSON.parse(inputBuf.toString("utf-8"));
        } catch {
            return { content: "Invalid JSON input", is_error: true };
        }
    }

    switch (toolName) {
        case "base64_encode":
            return {
                content: Buffer.from(input.input || "", "utf-8").toString("base64"),
            };

        case "base64_decode":
            try {
                return {
                    content: Buffer.from(input.input || "", "base64").toString("utf-8"),
                };
            } catch {
                return { content: "Invalid Base64 input", is_error: true };
            }

        case "hash":
            return {
                content: crypto
                    .createHash("sha256")
                    .update(input.input || "")
                    .digest("hex"),
            };

        default:
            return { content: `Unknown tool: ${toolName}`, is_error: true };
    }
}

// --- Protobuf message serializers ---

function serializeListToolsResponse(tools: typeof TOOLS): Buffer {
    const toolBuffers = tools.map((t) => {
        const fields = [
            encodeString(1, t.name),
            encodeString(2, t.description),
            encodeString(3, t.parameters),
        ];
        for (const cat of t.categories) {
            fields.push(encodeString(4, cat));
        }
        return encodeLengthDelimited(1, Buffer.concat(fields));
    });
    return Buffer.concat(toolBuffers);
}

function serializeExecuteResponse(result: ExecuteResult): Buffer {
    const fields: Buffer[] = [encodeString(1, result.content)];
    if (result.is_error) {
        fields.push(encodeBool(2, true));
    }
    return Buffer.concat(fields);
}

function deserializeExecuteRequest(data: Buffer): {
    toolName: string;
    input: Buffer;
} {
    let toolName = "";
    let input = Buffer.alloc(0);
    let offset = 0;

    while (offset < data.length) {
        const { value: tag, newOffset } = readVarint(data, offset);
        offset = newOffset;
        const fieldNum = tag >> 3;
        const wireType = tag & 0x7;

        if (wireType === 2) {
            const { value: len, newOffset: off2 } = readVarint(data, offset);
            offset = off2;
            const fieldData = data.subarray(offset, offset + len);
            offset += len;
            if (fieldNum === 1) toolName = fieldData.toString("utf-8");
            if (fieldNum === 2) input = Buffer.from(fieldData);
        } else if (wireType === 0) {
            const { newOffset: off2 } = readVarint(data, offset);
            offset = off2;
        }
    }

    return { toolName, input };
}

// --- gRPC server ---

function serve(): void {
    const cookie = process.env[MAGIC_COOKIE_KEY];
    if (cookie !== MAGIC_COOKIE_VALUE) {
        process.stderr.write(
            "Error: this binary is a ggcode plugin and must be launched by ggcode.\n"
        );
        process.exit(1);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcode-plugin-"));
    const socketPath = path.join(tmpDir, "plugin.sock");

    const server = new grpc.Server();

    // Register ToolService — @grpc/grpc-js requires definition and implementation
    // as two separate arguments (not combined into one object).
    const toolServiceDef = {
        ListTools: {
            path: "/ggcode.plugin.v1.ToolService/ListTools",
            requestStream: false,
            responseStream: false,
            requestDeserialize: () => Buffer.alloc(0),
            responseSerialize: (resp: Buffer) => resp,
        },
        Execute: {
            path: "/ggcode.plugin.v1.ToolService/Execute",
            requestStream: false,
            responseStream: false,
            requestDeserialize: (data: Buffer) => data,
            responseSerialize: (resp: Buffer) => resp,
        },
        Shutdown: {
            path: "/ggcode.plugin.v1.ToolService/Shutdown",
            requestStream: false,
            responseStream: false,
            requestDeserialize: () => Buffer.alloc(0),
            responseSerialize: (resp: Buffer) => resp,
        },
    } as any;

    server.addService(toolServiceDef, {
        ListTools: (_: any, callback: (err: any, resp: Buffer) => void) => {
            callback(null, serializeListToolsResponse(TOOLS));
        },
        Execute: (call: any, callback: (err: any, resp: Buffer) => void) => {
            const { toolName, input } = deserializeExecuteRequest(call.request);
            const result = executeTool(toolName, input);
            callback(null, serializeExecuteResponse(result));
        },
        Shutdown: (_: any, callback: (err: any, resp: Buffer) => void) => {
            callback(null, Buffer.alloc(0));
        },
    } as any);

    // Health service (go-plugin requires health checks)
    const healthServiceDef = {
        Check: {
            path: "/grpc.health.v1.Health/Check",
            requestStream: false,
            responseStream: false,
            requestDeserialize: () => Buffer.alloc(0),
            responseSerialize: (resp: Buffer) => resp,
        },
    } as any;

    server.addService(healthServiceDef, {
        Check: (_: any, callback: any) => {
            callback(null, Buffer.from([0x08, 0x01])); // SERVING
        },
    } as any);

    server.bindAsync(
        `unix://${socketPath}`,
        grpc.ServerCredentials.createInsecure(),
        (err) => {
            if (err) {
                process.stderr.write(`Failed to bind: ${err}\n`);
                process.exit(1);
            }

            // Print handshake line to stdout (go-plugin protocol)
            const handshake = `${CORE_PROTOCOL_VERSION}|${APP_PROTOCOL_VERSION}|unix|${socketPath}|grpc|`;
            process.stdout.write(handshake + "\n");
        }
    );
}

serve();
