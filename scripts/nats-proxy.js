#!/usr/bin/env node
// Standalone WebSocket-to-TCP proxy for NATS.
// Bridges browser WebSocket clients to standard NATS TCP (port 4222).
// Usage: node scripts/nats-proxy.js [port] [defaultTarget]
//   e.g. node scripts/nats-proxy.js 9222 127.0.0.1:4222
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const url = require("url");

const listenPort = parseInt(process.argv[2] || process.env.NATS_PROXY_PORT || "9222", 10);
const fallbackTarget = process.argv[3] || process.env.NATS_TARGET || "127.0.0.1:4222";

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLen = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < offset + 8) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLen) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      this.buffer = this.buffer.subarray(offset + payloadLen);
      this.onFrame(opcode, payload);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("NATS WebSocket-to-TCP Proxy. Connect via WebSocket.\n");
});

server.on("upgrade", (req, wsSocket, head) => {
  const parsed = url.parse(req.url, true);
  let target = parsed.query.target || fallbackTarget;
  if (!target.includes(":")) target += ":4222";
  const [host, portStr] = target.split(":");
  const port = parseInt(portStr, 10);

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    wsSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    wsSocket.destroy();
    return;
  }

  const tcpSocket = net.connect(port, host, () => {
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    const response = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n");

    wsSocket.write(response);

    const parser = new FrameParser((opcode, payload) => {
      switch (opcode) {
        case 0:
        case 1:
        case 2: // continuation, text, binary
          if (payload.length > 0) tcpSocket.write(payload);
          break;
        case 8: // close
          wsSocket.write(encodeFrame(8));
          wsSocket.end();
          tcpSocket.end();
          break;
        case 9: // ping
          wsSocket.write(encodeFrame(10, payload));
          break;
      }
    });

    if (head && head.length > 0) parser.push(head);
    wsSocket.on("data", chunk => parser.push(chunk));

    tcpSocket.on("data", chunk => {
      wsSocket.write(encodeFrame(2, chunk));
    });

    const cleanup = () => {
      tcpSocket.destroy();
      wsSocket.destroy();
    };

    tcpSocket.on("close", cleanup);
    tcpSocket.on("error", cleanup);
    wsSocket.on("close", cleanup);
    wsSocket.on("error", cleanup);
  });

  tcpSocket.on("error", err => {
    wsSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nCannot connect to NATS TCP (${target}): ${err.message}\n`);
    wsSocket.destroy();
  });
});

if (require.main === module) {
  server.listen(listenPort, () => {
    console.log(`NATS WebSocket-to-TCP proxy listening on ws://127.0.0.1:${listenPort}`);
    console.log(`Default target: nats://${fallbackTarget}`);
  });
}

module.exports = { server, encodeFrame, FrameParser };
