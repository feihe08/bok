import assert from 'node:assert/strict';
import { access, mkdtemp, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'bok-native-host-test-'));
const socketPath = join(directory, 'bridge.sock');
const hostPath = fileURLToPath(
  new URL('./bok-bookmark-native-host.mjs', import.meta.url),
);
const host = spawn(
  process.execPath,
  [hostPath, 'chrome-extension://ameahlgnnpiangoecbhfdpmapjndcnee/'],
  {
  env: { ...process.env, BOK_BOOKMARK_SOCKET_PATH: socketPath },
  stdio: ['pipe', 'pipe', 'pipe'],
  },
);

async function waitForSocket() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('native host did not create its socket');
}

function readNativeMessage(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      stream.off('data', onData);
      try {
        resolve(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    }
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function sendLocalRequest(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolve(JSON.parse(response)));
    socket.on('error', reject);
  });
}

try {
  await waitForSocket();
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);

  const request = {
    id: 'native-test',
    type: 'bok/bookmarks/plan',
    title: '中文标题',
  };
  const responsePromise = sendLocalRequest(request);
  assert.deepEqual(await readNativeMessage(host.stdout), request);

  const response = { id: request.id, ok: true, result: { connected: true } };
  host.stdin.write(frame(response));
  assert.deepEqual(await responsePromise, response);
} finally {
  host.kill('SIGTERM');
}

console.log('bookmark native host checks passed');
