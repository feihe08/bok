import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES_TO_KEEP = 3;
const EXPECTED_EXTENSION_ID = 'ameahlgnnpiangoecbhfdpmapjndcnee';
const CHROME_VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
);
const version = packageJson.version;

function parseChromeVersion(value) {
  if (typeof value !== 'string' || !CHROME_VERSION_PATTERN.test(value)) {
    return null;
  }
  const sourceParts = value.split('.');
  const parts = sourceParts.map(Number);
  if (
    parts.every((part) => part === 0) ||
    parts.some(
      (part, index) =>
        !Number.isSafeInteger(part) ||
        part > 65_535 ||
        String(part) !== sourceParts[index],
    )
  ) {
    return null;
  }
  return parts;
}

if (!parseChromeVersion(version)) {
  throw new Error(`Invalid Chrome extension version: ${String(version)}`);
}

const outputRoot = join(projectRoot, '.output');
const stagingRoot = join(outputRoot, '.release-staging');
const unpackedName = `bok-${version}-chrome`;
const zipName = `bok-chrome-${version}.zip`;
const stagedUnpacked = join(stagingRoot, unpackedName);
const stagedZip = join(stagingRoot, zipName);
const localUnpacked = join(outputRoot, unpackedName);
const localZip = join(outputRoot, zipName);
const iCloudReleaseRoot = join(
  homedir(),
  'Library',
  'Mobile Documents',
  'com~apple~CloudDocs',
  'Bok-development',
  'releases',
);
const iCloudUnpacked = join(iCloudReleaseRoot, unpackedName);
const iCloudZip = join(iCloudReleaseRoot, zipName);

function extensionIdFromKey(key) {
  const hash = createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32);
  return [...hash]
    .map((character) => 'abcdefghijklmnop'[Number.parseInt(character, 16)])
    .join('');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function validateUnpacked(path) {
  const manifest = JSON.parse(
    await readFile(join(path, 'manifest.json'), 'utf8'),
  );
  if (manifest.version !== version) {
    throw new Error(
      `Manifest version ${String(manifest.version)} does not match ${version}`,
    );
  }
  if (typeof manifest.key !== 'string' || !manifest.key) {
    throw new Error('Manifest public key is missing');
  }
  const extensionId = extensionIdFromKey(manifest.key);
  if (extensionId !== EXPECTED_EXTENSION_ID) {
    throw new Error(`Unexpected extension ID: ${extensionId}`);
  }
}

async function replaceReleasePair(
  sourceUnpacked,
  sourceZip,
  targetRoot,
  sourceZipHash,
) {
  await mkdir(targetRoot, { recursive: true });

  const targetUnpacked = join(targetRoot, unpackedName);
  const targetZip = join(targetRoot, zipName);

  const token = `${Date.now()}-${process.pid}`;
  const pendingUnpacked = join(
    targetRoot,
    `.${unpackedName}.staging-${token}`,
  );
  const pendingZip = join(targetRoot, `.${zipName}.staging-${token}`);
  const backupUnpacked = join(
    targetRoot,
    `.${unpackedName}.backup-${token}`,
  );
  const backupZip = join(targetRoot, `.${zipName}.backup-${token}`);

  let unpackedBackedUp = false;
  let zipBackedUp = false;
  let unpackedPromoted = false;
  let zipPromoted = false;

  try {
    await cp(sourceUnpacked, pendingUnpacked, { recursive: true });
    await copyFile(sourceZip, pendingZip);
    await validateUnpacked(pendingUnpacked);
    if ((await sha256(pendingZip)) !== sourceZipHash) {
      throw new Error('Staged ZIP hash does not match source ZIP');
    }

    if (await pathExists(targetUnpacked)) {
      await rename(targetUnpacked, backupUnpacked);
      unpackedBackedUp = true;
    }
    if (await pathExists(targetZip)) {
      await rename(targetZip, backupZip);
      zipBackedUp = true;
    }

    await rename(pendingUnpacked, targetUnpacked);
    unpackedPromoted = true;
    await rename(pendingZip, targetZip);
    zipPromoted = true;

    await validateUnpacked(targetUnpacked);
    if ((await sha256(targetZip)) !== sourceZipHash) {
      throw new Error('Published ZIP hash does not match source ZIP');
    }
  } catch (error) {
    if (zipPromoted) await rm(targetZip, { force: true });
    if (unpackedPromoted) {
      await rm(targetUnpacked, { recursive: true, force: true });
    }
    if (zipBackedUp && (await pathExists(backupZip))) {
      await rename(backupZip, targetZip);
    }
    if (unpackedBackedUp && (await pathExists(backupUnpacked))) {
      await rename(backupUnpacked, targetUnpacked);
    }
    await rm(pendingZip, { force: true });
    await rm(pendingUnpacked, { recursive: true, force: true });
    throw error;
  }

  if (zipBackedUp) await rm(backupZip, { force: true });
  if (unpackedBackedUp) {
    await rm(backupUnpacked, { recursive: true, force: true });
  }
}

function compareChromeVersions(left, right) {
  const leftParts = parseChromeVersion(left);
  const rightParts = parseChromeVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function pruneReleases(root) {
  const unpackedPattern = /^bok-(\d+(?:\.\d+){0,3})-chrome$/;
  const zipPattern = /^bok-chrome-(\d+(?:\.\d+){0,3})\.zip$/;
  const legacyZipPattern = /^bok-(\d+(?:\.\d+){0,3})-chrome\.zip$/;
  const entries = await readdir(root, { withFileTypes: true });
  const versionByEntry = new Map();

  for (const entry of entries) {
    const unpackedMatch = entry.isDirectory()
      ? entry.name.match(unpackedPattern)
      : null;
    const zipMatch = entry.isFile()
      ? entry.name.match(zipPattern) ?? entry.name.match(legacyZipPattern)
      : null;
    const entryVersion = unpackedMatch?.[1] ?? zipMatch?.[1];
    if (entryVersion && parseChromeVersion(entryVersion)) {
      versionByEntry.set(entry.name, entryVersion);
    }
  }

  const keptVersions = [...new Set(versionByEntry.values())]
    .sort((left, right) => compareChromeVersions(right, left))
    .slice(0, RELEASES_TO_KEEP);
  const keptVersionSet = new Set(keptVersions);
  const removedEntries = [];

  for (const [name, entryVersion] of versionByEntry) {
    if (keptVersionSet.has(entryVersion)) continue;
    await rm(join(root, name), { recursive: true, force: true });
    removedEntries.push(name);
  }

  return { keptVersions, removedEntries };
}

await validateUnpacked(stagedUnpacked);
await access(stagedZip);
const localZipHash = await sha256(stagedZip);
await replaceReleasePair(
  stagedUnpacked,
  stagedZip,
  outputRoot,
  localZipHash,
);
await rm(stagingRoot, { recursive: true, force: true });
await replaceReleasePair(
  localUnpacked,
  localZip,
  iCloudReleaseRoot,
  localZipHash,
);
const localPrune = await pruneReleases(outputRoot);
const iCloudPrune = await pruneReleases(iCloudReleaseRoot);

console.log(`Local unpacked: ${localUnpacked}`);
console.log(`Local ZIP: ${localZip}`);
console.log(`iCloud unpacked: ${iCloudUnpacked}`);
console.log(`iCloud ZIP: ${iCloudZip}`);
console.log(`Kept local versions: ${localPrune.keptVersions.join(', ')}`);
console.log(`Kept iCloud versions: ${iCloudPrune.keptVersions.join(', ')}`);
if (localPrune.removedEntries.length > 0) {
  console.log(
    `Removed old local artifacts: ${localPrune.removedEntries.join(', ')}`,
  );
}
if (iCloudPrune.removedEntries.length > 0) {
  console.log(
    `Removed old iCloud artifacts: ${iCloudPrune.removedEntries.join(', ')}`,
  );
}
