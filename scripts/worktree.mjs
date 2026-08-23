import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINKED_WORKTREES = 10;
const BRANCH_PREFIX = 'codex/';
const LOCK_TIMEOUT_SECONDS = '30';
const STATE_FILE = '.bok-worktree-state.json';
const LOCKED_COMMANDS = new Set([
  'create',
  'touch',
  'reuse',
  'merge',
  'close',
  'prune',
]);
const scriptPath = fileURLToPath(import.meta.url);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(
      detail || `${command} exited with status ${String(result.status)}`,
    );
  }
  return result;
}

function git(args, cwd = process.cwd()) {
  return run('git', args, { cwd }).stdout.trim();
}

function gitSucceeds(args, cwd = process.cwd()) {
  return run('git', args, { cwd, allowFailure: true }).status === 0;
}

function getRepository() {
  const commonDirectory = resolve(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  if (basename(commonDirectory) !== '.git') {
    throw new Error('Bare repositories are not supported.');
  }

  const primaryRoot = dirname(commonDirectory);
  return {
    commonDirectory,
    primaryRoot,
    managedRoot: join(
      dirname(primaryRoot),
      `${basename(primaryRoot)}-worktrees`,
    ),
  };
}

function readWorktrees(cwd = process.cwd()) {
  const tokens = run(
    'git',
    ['worktree', 'list', '--porcelain', '-z'],
    { cwd },
  ).stdout.split('\0');
  const worktrees = [];
  let current = {};

  for (const token of tokens) {
    if (token === '') {
      if (current.path) worktrees.push(current);
      current = {};
      continue;
    }

    const separator = token.indexOf(' ');
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? true : token.slice(separator + 1);
    if (key === 'worktree') current.path = value;
    if (key === 'HEAD') current.head = value;
    if (key === 'branch') current.branch = value;
    if (key === 'detached') current.detached = true;
    if (key === 'locked') current.locked = value;
    if (key === 'prunable') current.prunable = value;
  }

  return worktrees;
}

function linkedWorktrees(repository) {
  return readWorktrees(repository.primaryRoot).filter(
    (worktree) => resolve(worktree.path) !== repository.primaryRoot,
  );
}

function assertSlug(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) {
    throw new Error(
      'Slug must use 1-48 lowercase ASCII letters, digits, or hyphens.',
    );
  }
}

function isSlug(slug) {
  return Boolean(slug && /^[a-z0-9][a-z0-9-]{0,47}$/.test(slug));
}

function assertPrimaryReady(repository, requireClean = true) {
  const branch = git(['symbolic-ref', '--short', 'HEAD'], repository.primaryRoot);
  if (branch !== 'main') {
    throw new Error(`Primary checkout must be on main; found ${branch}.`);
  }
  if (
    requireClean &&
    git(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      repository.primaryRoot,
    )
  ) {
    throw new Error('Primary checkout must be clean.');
  }
}

function assertClean(path, label) {
  if (git(['status', '--porcelain=v1', '--untracked-files=all'], path)) {
    throw new Error(`${label} must be clean.`);
  }
}

function isClean(path) {
  return !git(['status', '--porcelain=v1', '--untracked-files=all'], path);
}

function managedIdentity(repository, worktree) {
  const path = resolve(worktree.path);
  const pathFromManagedRoot = relative(resolve(repository.managedRoot), path);
  if (
    pathFromManagedRoot.startsWith('..') ||
    pathFromManagedRoot === '' ||
    pathFromManagedRoot.includes('/')
  ) {
    return undefined;
  }

  const slug = pathFromManagedRoot;
  if (!isSlug(slug)) return undefined;
  const branch = `${BRANCH_PREFIX}${slug}`;
  if (worktree.branch !== `refs/heads/${branch}`) return undefined;
  return { slug, branch, path };
}

function isIsoDate(value) {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function readManagedState(repository, worktree) {
  const identity = managedIdentity(repository, worktree);
  if (!identity) return { error: 'not manager-owned' };

  let state;
  try {
    state = JSON.parse(readFileSync(join(identity.path, STATE_FILE), 'utf8'));
  } catch (error) {
    return {
      identity,
      missing: error.code === 'ENOENT',
      error:
        error.code === 'ENOENT' ? `missing ${STATE_FILE}` : `invalid ${STATE_FILE}`,
    };
  }
  if (
    state === null ||
    typeof state !== 'object' ||
    state.version !== 1 ||
    state.slug !== identity.slug ||
    !['active', 'retained'].includes(state.state) ||
    !isIsoDate(state.createdAt) ||
    !isIsoDate(state.lastActivityAt) ||
    Date.parse(state.createdAt) > Date.parse(state.lastActivityAt)
  ) {
    return { identity, error: `invalid ${STATE_FILE}` };
  }
  return { identity, state };
}

function writeState(path, state) {
  const statePath = join(path, STATE_FILE);
  const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      flag: 'wx',
    });
    renameSync(temporaryPath, statePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function createState(path, slug) {
  const now = new Date().toISOString();
  writeState(path, {
    version: 1,
    slug,
    state: 'active',
    createdAt: now,
    lastActivityAt: now,
  });
}

function updateState(repository, worktree, nextState, refreshActivity) {
  const stateResult = readManagedState(repository, worktree);
  if (stateResult.error) {
    throw new Error(
      `Cannot update ${stateResult.identity?.slug ?? worktree.path}: ${stateResult.error}.`,
    );
  }
  writeState(stateResult.identity.path, {
    ...stateResult.state,
    state: nextState,
    lastActivityAt: refreshActivity
      ? new Date().toISOString()
      : stateResult.state.lastActivityAt,
  });
}

function assertUsableWorktree(worktree, action) {
  if (worktree.locked) {
    throw new Error(`Cannot ${action} a locked worktree: ${worktree.path}`);
  }
  if (worktree.prunable) {
    throw new Error(`Cannot ${action} a prunable worktree: ${worktree.path}`);
  }
}

function findManagedWorktree(repository, slug) {
  const targetPath = join(repository.managedRoot, slug);
  const worktree = linkedWorktrees(repository).find(
    (candidate) => resolve(candidate.path) === resolve(targetPath),
  );
  if (!worktree) throw new Error(`Managed worktree not found: ${slug}`);

  const expectedBranch = `refs/heads/${BRANCH_PREFIX}${slug}`;
  if (worktree.branch !== expectedBranch) {
    throw new Error(
      `Expected ${BRANCH_PREFIX}${slug}, found ${worktree.branch ?? 'detached HEAD'}.`,
    );
  }
  return worktree;
}

function currentLinkedWorktree(repository) {
  let currentRoot;
  try {
    currentRoot = resolve(git(['rev-parse', '--show-toplevel']));
  } catch {
    return undefined;
  }
  return linkedWorktrees(repository).find(
    (worktree) => resolve(worktree.path) === currentRoot,
  );
}

function eligibleRetainedWorktrees(repository, linked) {
  const current = currentLinkedWorktree(repository);
  const currentPath = current && resolve(current.path);
  const candidates = [];

  for (const worktree of linked) {
    if (
      worktree.locked ||
      worktree.prunable ||
      resolve(worktree.path) === currentPath
    ) {
      continue;
    }
    const stateResult = readManagedState(repository, worktree);
    if (stateResult.error || stateResult.state.state !== 'retained') continue;
    if (!isClean(worktree.path)) continue;
    if (
      !gitSucceeds(
        ['merge-base', '--is-ancestor', stateResult.identity.branch, 'main'],
        repository.primaryRoot,
      )
    ) {
      continue;
    }

    candidates.push({
      ...stateResult.identity,
      worktree,
      activityTimestamp: Date.parse(stateResult.state.lastActivityAt),
      canonicalPath: realpathSync.native(worktree.path),
    });
  }

  return candidates.sort(
    (left, right) =>
      left.activityTimestamp - right.activityTimestamp ||
      left.canonicalPath.localeCompare(right.canonicalPath),
  );
}

function removeManagedWorktree(repository, worktree, branch) {
  run('git', ['worktree', 'remove', worktree.path], {
    cwd: repository.primaryRoot,
    inherit: true,
  });
  run('git', ['branch', '-d', branch], {
    cwd: repository.primaryRoot,
    inherit: true,
  });
}

function list() {
  const repository = getRepository();
  const worktrees = readWorktrees(repository.primaryRoot);
  const linked = linkedWorktrees(repository);
  console.log(`Linked worktrees: ${linked.length}/${MAX_LINKED_WORKTREES}`);
  for (const worktree of worktrees) {
    const branch = worktree.branch?.replace('refs/heads/', '') ?? 'detached';
    const flags = [worktree.locked && 'locked', worktree.prunable && 'prunable']
      .filter(Boolean)
      .join(', ');
    const stateResult = readManagedState(repository, worktree);
    const state = stateResult.state
      ? `state=${stateResult.state.state} lastActivity=${stateResult.state.lastActivityAt}`
      : resolve(worktree.path) === repository.primaryRoot
        ? 'primary'
        : stateResult.missing || stateResult.error === 'not manager-owned'
          ? 'unmanaged'
          : stateResult.error;
    console.log(
      `${worktree.path}  ${branch}${flags ? `  (${flags})` : ''}  ${state}`,
    );
  }
}

function doctor() {
  const repository = getRepository();
  const linked = linkedWorktrees(repository);
  const issues = [];

  if (linked.length > MAX_LINKED_WORKTREES) {
    issues.push(
      `${linked.length} linked worktrees exceed the limit of ${MAX_LINKED_WORKTREES}.`,
    );
  }
  for (const worktree of linked) {
    if (worktree.prunable) {
      issues.push(`Prunable entry still occupies a slot: ${worktree.path}`);
    }
    const stateResult = readManagedState(repository, worktree);
    if (stateResult.error) {
      if (!stateResult.missing && stateResult.error !== 'not manager-owned') {
        issues.push(
          `Invalid worktree state at ${worktree.path}: ${stateResult.error}.`,
        );
      }
    } else if (
      stateResult.state.state === 'retained' &&
      !gitSucceeds(
        [
          'merge-base',
          '--is-ancestor',
          stateResult.identity.branch,
          'main',
        ],
        repository.primaryRoot,
      )
    ) {
      issues.push(`Retained worktree is not merged: ${worktree.path}`);
    }
  }
  try {
    assertPrimaryReady(repository, false);
  } catch (error) {
    issues.push(error.message);
  }

  console.log(`Linked worktrees: ${linked.length}/${MAX_LINKED_WORKTREES}`);
  if (issues.length === 0) {
    console.log('Worktree registry is healthy.');
    return;
  }
  for (const issue of issues) console.error(`- ${issue}`);
  if (linked.some((worktree) => worktree.prunable)) {
    console.error('Run `pnpm worktree prune` to preview stale metadata cleanup.');
  }
  process.exitCode = 1;
}

function create(slug) {
  assertSlug(slug);
  const repository = getRepository();
  assertPrimaryReady(repository, false);

  const branch = `${BRANCH_PREFIX}${slug}`;
  const targetPath = join(repository.managedRoot, slug);
  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  if (existsSync(targetPath)) {
    throw new Error(`Path already exists: ${targetPath}`);
  }

  const linked = linkedWorktrees(repository);
  if (linked.length > MAX_LINKED_WORKTREES) {
    throw new Error(
      `${linked.length} linked worktrees already exceed the limit of ${MAX_LINKED_WORKTREES}; inspect them before creating another.`,
    );
  }
  if (linked.length === MAX_LINKED_WORKTREES) {
    const candidate = eligibleRetainedWorktrees(repository, linked)[0];
    if (!candidate) {
      throw new Error(
        `Cannot create another worktree: ${linked.length}/${MAX_LINKED_WORKTREES} slots are occupied and no safe retained slot is eligible for removal.`,
      );
    }
    removeManagedWorktree(repository, candidate.worktree, candidate.branch);
    console.log(
      `Removed least-recently-active retained worktree ${candidate.path}.`,
    );
  }

  mkdirSync(repository.managedRoot, { recursive: true });
  run(
    'git',
    ['worktree', 'add', '-b', branch, targetPath, 'main'],
    { cwd: repository.primaryRoot, inherit: true },
  );
  try {
    createState(targetPath, slug);
  } catch (error) {
    const createdWorktree = linkedWorktrees(repository).find(
      (worktree) => resolve(worktree.path) === resolve(targetPath),
    );
    if (createdWorktree && isClean(targetPath)) {
      removeManagedWorktree(repository, createdWorktree, branch);
    }
    throw error;
  }
  console.log(`Created ${branch} at ${targetPath}`);
  console.log(`Next: cd ${targetPath} && pnpm install --frozen-lockfile`);
}

function touch(slug) {
  if (slug !== undefined) assertSlug(slug);
  const repository = getRepository();
  const worktree = slug
    ? findManagedWorktree(repository, slug)
    : currentLinkedWorktree(repository);
  if (!worktree) {
    throw new Error(
      'Cannot infer a managed linked worktree; use `pnpm worktree touch <slug>`.',
    );
  }
  const stateResult = readManagedState(repository, worktree);
  if (stateResult.error) {
    throw new Error(`Cannot touch worktree: ${stateResult.error}.`);
  }
  updateState(repository, worktree, stateResult.state.state, true);
  console.log(`Updated activity for ${stateResult.identity.slug}.`);
}

function reuse(slug) {
  assertSlug(slug);
  const repository = getRepository();
  assertPrimaryReady(repository, false);
  const worktree = findManagedWorktree(repository, slug);
  assertUsableWorktree(worktree, 'reuse');
  assertClean(worktree.path, 'Retained worktree');
  const stateResult = readManagedState(repository, worktree);
  if (stateResult.error || stateResult.state.state !== 'retained') {
    throw new Error(`Worktree ${slug} must have valid retained state before reuse.`);
  }
  if (
    !gitSucceeds(
      ['merge-base', '--is-ancestor', stateResult.identity.branch, 'main'],
      repository.primaryRoot,
    )
  ) {
    throw new Error(`Cannot reuse unmerged branch: ${stateResult.identity.branch}`);
  }

  run('git', ['merge', '--ff-only', 'main'], {
    cwd: worktree.path,
    inherit: true,
  });
  const featureHead = git(['rev-parse', 'HEAD'], worktree.path);
  const mainHead = git(['rev-parse', 'main'], repository.primaryRoot);
  if (featureHead !== mainHead) {
    throw new Error('Reuse completed at an unexpected commit.');
  }
  assertClean(worktree.path, 'Reused worktree');
  updateState(repository, worktree, 'active', true);
  console.log(`Reused ${stateResult.identity.branch} at ${mainHead}.`);
}

function merge(slug, option, verifiedSha) {
  assertSlug(slug);
  if (option !== '--verified-sha' || !/^[0-9a-f]{40}$/.test(verifiedSha ?? '')) {
    throw new Error(
      'Usage: pnpm worktree merge <slug> --verified-sha <40-char-sha>',
    );
  }

  const repository = getRepository();
  const worktree = findManagedWorktree(repository, slug);
  assertUsableWorktree(worktree, 'merge');
  assertPrimaryReady(repository);
  assertClean(worktree.path, 'Feature worktree');
  const stateResult = readManagedState(repository, worktree);
  if (stateResult.error || stateResult.state.state !== 'active') {
    throw new Error(`Worktree ${slug} must have valid active state before merge.`);
  }

  const branch = `${BRANCH_PREFIX}${slug}`;
  const featureHead = git(['rev-parse', branch], repository.primaryRoot);
  if (featureHead !== verifiedSha) {
    throw new Error(
      `Verified SHA does not match the current feature tip (${featureHead}).`,
    );
  }
  const mainHead = git(['rev-parse', 'main'], repository.primaryRoot);
  if (!gitSucceeds(['merge-base', '--is-ancestor', mainHead, featureHead])) {
    throw new Error(
      'Feature branch is not a fast-forward of current main; update it and verify again.',
    );
  }

  run('git', ['merge', '--ff-only', verifiedSha], {
    cwd: repository.primaryRoot,
    inherit: true,
  });
  const mergedHead = git(['rev-parse', 'main'], repository.primaryRoot);
  if (mergedHead !== verifiedSha) {
    throw new Error('Merge completed at an unexpected commit.');
  }
  assertClean(repository.primaryRoot, 'Primary checkout');
  const currentFeatureHead = git(['rev-parse', branch], repository.primaryRoot);
  if (currentFeatureHead !== verifiedSha) {
    throw new Error(
      `Merged verified SHA, but ${branch} advanced to ${currentFeatureHead}; do not close it.`,
    );
  }
  const worktreeHead = git(['rev-parse', 'HEAD'], worktree.path);
  if (currentFeatureHead !== mergedHead || worktreeHead !== mergedHead) {
    throw new Error('Feature worktree HEAD does not match merged main.');
  }
  updateState(repository, worktree, 'retained', true);
  console.log(`Merged ${branch} at ${verifiedSha}.`);
  console.log(`Retained ${worktree.path} for reuse.`);
}

function close(slug) {
  assertSlug(slug);
  const repository = getRepository();
  const worktree = findManagedWorktree(repository, slug);
  assertUsableWorktree(worktree, 'close');
  assertClean(worktree.path, 'Feature worktree');

  const branch = `${BRANCH_PREFIX}${slug}`;
  if (!gitSucceeds(['merge-base', '--is-ancestor', branch, 'main'])) {
    throw new Error(`Cannot close unmerged branch: ${branch}`);
  }

  removeManagedWorktree(repository, worktree, branch);
  console.log(`Removed ${worktree.path} and deleted ${branch}.`);
}

function prune(option) {
  if (option !== undefined && option !== '--apply') {
    throw new Error('Usage: pnpm worktree prune [--apply]');
  }

  const repository = getRepository();
  const staleWorktrees = linkedWorktrees(repository).filter(
    (worktree) => worktree.prunable,
  );
  if (staleWorktrees.length > 0) {
    console.log(
      option === '--apply'
        ? 'Removing stale worktree metadata:'
        : 'Stale worktree metadata preview:',
    );
    for (const worktree of staleWorktrees) console.log(`- ${worktree.path}`);
  }
  const args = [
    'worktree',
    'prune',
    '--verbose',
    '--expire',
    'now',
    ...(option === '--apply' ? [] : ['--dry-run']),
  ];
  const result = run('git', args, {
    cwd: repository.primaryRoot,
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'Failed to inspect stale worktrees.');
  }

  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (output) console.log(output);
  if (staleWorktrees.length === 0) {
    console.log('No stale worktree metadata found.');
  } else if (option !== '--apply') {
    console.log(
      'Preview only. After explicit user confirmation, run `pnpm worktree prune --apply`.',
    );
  }
}

function help() {
  console.log(`Usage:
  pnpm worktree list
  pnpm worktree doctor
  pnpm worktree create <slug>
  pnpm worktree touch [slug]
  pnpm worktree reuse <slug>
  pnpm worktree merge <slug> --verified-sha <40-char-sha>
  pnpm worktree close <slug>
  pnpm worktree prune [--apply]`);
}

function runWithSharedLock(args) {
  const repository = getRepository();
  const lockPath = join(repository.commonDirectory, 'bok-worktree.lock');
  const result = run(
    '/usr/bin/lockf',
    [
      '-k',
      '-t',
      LOCK_TIMEOUT_SECONDS,
      lockPath,
      process.execPath,
      scriptPath,
      ...args,
    ],
    {
      env: { ...process.env, BOK_WORKTREE_LOCK_HELD: '1' },
      inherit: true,
      allowFailure: true,
    },
  );
  process.exitCode = result.status ?? 1;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';

  if (
    LOCKED_COMMANDS.has(command) &&
    process.env.BOK_WORKTREE_LOCK_HELD !== '1'
  ) {
    runWithSharedLock(args);
    return;
  }

  if (command === 'list') return list();
  if (command === 'doctor') return doctor();
  if (command === 'create') return create(args[1]);
  if (command === 'touch') return touch(args[1]);
  if (command === 'reuse') return reuse(args[1]);
  if (command === 'merge') return merge(...args.slice(1));
  if (command === 'close') return close(args[1]);
  if (command === 'prune') return prune(args[1]);
  if (command === 'help' || command === '--help' || command === '-h') {
    return help();
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`worktree: ${error.message}`);
  process.exitCode = 1;
}
