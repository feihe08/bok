#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const socketPath =
  process.env.BOK_BOOKMARK_SOCKET_PATH ??
  join(tmpdir(), `bok-bookmarks-${process.getuid?.() ?? 'user'}.sock`);
const [command = 'help', planPath] = process.argv.slice(2);

function usage() {
  return [
    'Usage:',
    '  pnpm bookmarks:codex ping',
    '  pnpm bookmarks:codex tree',
    '  pnpm bookmarks:codex plan <plan.json>',
    '  pnpm bookmarks:codex apply <plan.json>',
  ].join('\n');
}

async function makeRequest() {
  const id = randomUUID();
  if (command === 'ping') return { id, type: 'bok/bookmarks/ping' };
  if (command === 'tree') return { id, type: 'bok/bookmarks/read-tree' };
  if (command === 'plan' || command === 'apply') {
    if (!planPath) throw new Error(`${command} requires a JSON plan path`);
    const parsed = JSON.parse(await readFile(planPath, 'utf8'));
    const operations = Array.isArray(parsed) ? parsed : parsed.operations;
    return {
      id,
      type: 'bok/bookmarks/plan',
      apply: command === 'apply',
      operations,
    };
  }
  throw new Error(usage());
}

function send(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Bok bookmark bridge did not respond within 30 seconds'));
    }, 30_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      if (error && error.code === 'ENOENT') {
        reject(
          new Error(
            'Bok bookmark bridge is not connected. Install the native host, enable the Codex bridge in Bok settings, then reload Bok.',
          ),
        );
      } else {
        reject(error);
      }
    });
  });
}

try {
  const response = await send(await makeRequest());
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
