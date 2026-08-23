import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINKED_WORKTREES = 6;
const BRANCH_PREFIX = 'codex/';
const LOCK_TIMEOUT_SECONDS = '30';
const LOCKED_COMMANDS = new Set(['create', 'merge', 'close', 'prune']);
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
    console.log(`${worktree.path}  ${branch}${flags ? `  (${flags})` : ''}`);
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

  const linked = linkedWorktrees(repository);
  if (linked.length >= MAX_LINKED_WORKTREES) {
    throw new Error(
      `Cannot create another worktree: ${linked.length}/${MAX_LINKED_WORKTREES} slots are occupied.`,
    );
  }

  const branch = `${BRANCH_PREFIX}${slug}`;
  const targetPath = join(repository.managedRoot, slug);
  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  if (existsSync(targetPath)) {
    throw new Error(`Path already exists: ${targetPath}`);
  }

  mkdirSync(repository.managedRoot, { recursive: true });
  run(
    'git',
    ['worktree', 'add', '-b', branch, targetPath, 'main'],
    { cwd: repository.primaryRoot, inherit: true },
  );
  console.log(`Created ${branch} at ${targetPath}`);
  console.log(`Next: cd ${targetPath} && pnpm install --frozen-lockfile`);
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
  assertPrimaryReady(repository);
  assertClean(worktree.path, 'Feature worktree');

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
  console.log(`Merged ${branch} at ${verifiedSha}.`);
}

function close(slug) {
  assertSlug(slug);
  const repository = getRepository();
  const worktree = findManagedWorktree(repository, slug);
  assertClean(worktree.path, 'Feature worktree');

  const branch = `${BRANCH_PREFIX}${slug}`;
  if (!gitSucceeds(['merge-base', '--is-ancestor', branch, 'main'])) {
    throw new Error(`Cannot close unmerged branch: ${branch}`);
  }

  run('git', ['worktree', 'remove', worktree.path], {
    cwd: repository.primaryRoot,
    inherit: true,
  });
  run('git', ['branch', '-d', branch], {
    cwd: repository.primaryRoot,
    inherit: true,
  });
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
