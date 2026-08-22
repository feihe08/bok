#!/usr/bin/env node

import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_ID = 'ameahlgnnpiangoecbhfdpmapjndcnee';
const HOST_NAME = 'com.hefei.bok.bookmarks';
const supportDirectory = join(homedir(), 'Library', 'Application Support', 'Bok');
const installedHost = join(supportDirectory, 'bok-bookmark-native-host.mjs');
const executable = join(supportDirectory, 'bok-bookmark-native-host');
const manifestPath = join(
  homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts',
  `${HOST_NAME}.json`,
);
const sourceHost = fileURLToPath(
  new URL('./bok-bookmark-native-host.mjs', import.meta.url),
);

async function findNodeExecutable() {
  for (const candidate of [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    process.execPath,
  ]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next stable location.
    }
  }
  throw new Error('Cannot find an executable Node.js runtime');
}

await mkdir(supportDirectory, { recursive: true });
await mkdir(dirname(manifestPath), { recursive: true });
await copyFile(sourceHost, installedHost);
const nodeExecutable = await findNodeExecutable();
await writeFile(
  executable,
  `#!/bin/sh\nexec ${JSON.stringify(nodeExecutable)} ${JSON.stringify(installedHost)} "$@"\n`,
  'utf8',
);
await chmod(executable, 0o755);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Bok bookmark bridge for local Codex commands',
      path: executable,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

process.stdout.write(
  `Installed ${HOST_NAME}\nManifest: ${manifestPath}\nHost: ${executable}\n`,
);
