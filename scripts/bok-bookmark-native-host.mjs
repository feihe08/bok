#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socketPath =
  process.env.BOK_BOOKMARK_SOCKET_PATH ??
  join(tmpdir(), `bok-bookmarks-${process.getuid?.() ?? 'user'}.sock`);
const pending = new Map();
let input = Buffer.alloc(0);
const MAX_LOCAL_REQUEST_BYTES = 1024 * 1024;
const CLIENT_TIMEOUT_MS = 30_000;
const ALLOWED_EXTENSION_ORIGIN =
  'chrome-extension://ameahlgnnpiangoecbhfdpmapjndcnee/';

if (process.argv[2] !== ALLOWED_EXTENSION_ORIGIN) {
  throw new Error(`Unexpected extension origin: ${process.argv[2] ?? 'missing'}`);
}

function sendToChrome(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function finishClient(id, response) {
  const socket = pending.get(id);
  if (!socket) return;
  pending.delete(id);
  socket.end(`${JSON.stringify(response)}\n`);
}

function handleChromeMessage(message) {
  if (!message || typeof message.id !== 'string') return;
  finishClient(message.id, message);
}

function readChromeMessages(chunk) {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > 1024 * 1024) throw new Error('Chrome response exceeds 1 MiB');
    if (input.length < length + 4) return;
    const payload = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    handleChromeMessage(JSON.parse(payload.toString('utf8')));
  }
}

async function prepareSocket() {
  if (!existsSync(socketPath)) return;
  const existing = lstatSync(socketPath);
  if (!existing.isSocket()) {
    throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
  }

  await new Promise((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once('connect', () => {
      probe.end();
      reject(new Error('Bok bookmark native host is already running'));
    });
    probe.once('error', (error) => {
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') {
        reject(error);
        return;
      }
      unlinkSync(socketPath);
      resolve();
    });
  });
}

await prepareSocket();

const server = createServer((socket) => {
  socket.setEncoding('utf8');
  socket.setTimeout(CLIENT_TIMEOUT_MS, () => {
    socket.end(`${JSON.stringify({ ok: false, error: 'Request timed out' })}\n`);
  });
  socket.on('error', () => undefined);
  let line = '';
  socket.on('data', (chunk) => {
    line += chunk;
    if (Buffer.byteLength(line, 'utf8') > MAX_LOCAL_REQUEST_BYTES) {
      socket.end(`${JSON.stringify({ ok: false, error: 'Request exceeds 1 MiB' })}\n`);
      return;
    }
    const newline = line.indexOf('\n');
    if (newline < 0) return;
    const raw = line.slice(0, newline);
    line = '';
    try {
      const request = JSON.parse(raw);
      if (!request || typeof request.id !== 'string') {
        throw new Error('Request requires a string id');
      }
      if (pending.has(request.id)) throw new Error(`Duplicate request id: ${request.id}`);
      pending.set(request.id, socket);
      sendToChrome(request);
      socket.pause();
    } catch (error) {
      socket.end(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  });
  socket.on('close', () => {
    for (const [id, pendingSocket] of pending) {
      if (pendingSocket === socket) pending.delete(id);
    }
  });
});

server.listen(socketPath, () => chmodSync(socketPath, 0o600));
process.stdin.on('data', readChromeMessages);
process.stdin.on('end', () => server.close());
process.stdin.resume();

function cleanup() {
  try {
    if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
  } catch {
    // Chrome is already shutting the host down.
  }
}

process.on('exit', cleanup);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
