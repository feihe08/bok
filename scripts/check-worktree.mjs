import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const managerPath = fileURLToPath(new URL('./worktree.mjs', import.meta.url));

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BOK_WORKTREE_LOCK_HELD: '' },
  });
  assert.equal(
    result.status,
    expectedStatus,
    result.stderr || result.stdout || `${command} failed`,
  );
  return result;
}

function runManager(args, cwd, expectedStatus = 0) {
  return run(process.execPath, [managerPath, ...args], cwd, expectedStatus);
}

function runManagerAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [managerPath, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, BOK_WORKTREE_LOCK_HELD: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'bok-worktree-check-'));
const repositoryRoot = join(temporaryRoot, 'repo');

try {
  await mkdir(repositoryRoot);
  run('git', ['init', '-b', 'main'], repositoryRoot);
  run('git', ['config', 'user.name', 'Bok Worktree Check'], repositoryRoot);
  run('git', ['config', 'user.email', 'worktree-check@example.invalid'], repositoryRoot);
  await writeFile(join(repositoryRoot, 'base.txt'), 'base\n');
  run('git', ['add', 'base.txt'], repositoryRoot);
  run('git', ['commit', '-m', 'test: initialize repository'], repositoryRoot);

  await writeFile(join(repositoryRoot, 'base.txt'), 'uncommitted\n');
  await writeFile(join(repositoryRoot, 'local.txt'), 'preserve me\n');

  const slugs = Array.from({ length: 7 }, (_, index) => `parallel-${index + 1}`);
  const results = await Promise.all(
    slugs.map((slug) => runManagerAsync(['create', slug], repositoryRoot)),
  );
  const successfulSlugs = slugs.filter((_, index) => results[index].status === 0);
  const failures = results.filter((result) => result.status !== 0);
  assert.equal(successfulSlugs.length, 6);
  assert.equal(failures.length, 1);
  assert.match(failures[0].stderr, /6\/6 slots are occupied/);

  const listResult = runManager(['list'], repositoryRoot);
  assert.match(listResult.stdout, /Linked worktrees: 6\/6/);
  for (const slug of successfulSlugs) {
    const worktreeRoot = join(temporaryRoot, 'repo-worktrees', slug);
    assert.equal(await readFile(join(worktreeRoot, 'base.txt'), 'utf8'), 'base\n');
    await assert.rejects(readFile(join(worktreeRoot, 'local.txt'), 'utf8'));
  }
  for (const slug of successfulSlugs) runManager(['close', slug], repositoryRoot);
  assert.equal(await readFile(join(repositoryRoot, 'base.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(await readFile(join(repositoryRoot, 'local.txt'), 'utf8'), 'preserve me\n');
  await writeFile(join(repositoryRoot, 'base.txt'), 'base\n');
  await unlink(join(repositoryRoot, 'local.txt'));

  runManager(['create', 'prune-check'], repositoryRoot);
  const prunableRoot = await realpath(
    join(temporaryRoot, 'repo-worktrees', 'prune-check'),
  );
  await rm(prunableRoot, { recursive: true, force: true });
  const doctorResult = runManager(['doctor'], repositoryRoot, 1);
  assert.match(doctorResult.stderr, /Prunable entry still occupies a slot/);
  const prunePreview = runManager(['prune'], repositoryRoot);
  assert.match(prunePreview.stdout, /Preview only/);
  assert.ok(prunePreview.stdout.includes(prunableRoot));
  const afterPreview = run(
    'git',
    ['worktree', 'list', '--porcelain'],
    repositoryRoot,
  ).stdout;
  assert.ok(
    afterPreview.includes(`worktree ${prunableRoot}\n`),
    afterPreview,
  );
  runManager(['prune', '--apply'], repositoryRoot);
  assert.ok(
    !run('git', ['worktree', 'list', '--porcelain'], repositoryRoot)
      .stdout.includes(`worktree ${prunableRoot}\n`),
  );
  run('git', ['branch', '-d', 'codex/prune-check'], repositoryRoot);

  runManager(['create', 'merge-check'], repositoryRoot);
  const featureRoot = join(temporaryRoot, 'repo-worktrees', 'merge-check');
  await writeFile(join(featureRoot, 'feature.txt'), 'verified\n');
  run('git', ['add', 'feature.txt'], featureRoot);
  run('git', ['commit', '-m', 'test: add verified change'], featureRoot);
  const verifiedSha = run('git', ['rev-parse', 'HEAD'], featureRoot).stdout.trim();

  const rejected = runManager(
    ['merge', 'merge-check', '--verified-sha', '0000000000000000000000000000000000000000'],
    repositoryRoot,
    1,
  );
  assert.match(rejected.stderr, /does not match the current feature tip/);

  runManager(
    ['merge', 'merge-check', '--verified-sha', verifiedSha],
    repositoryRoot,
  );
  runManager(['close', 'merge-check'], repositoryRoot);
  assert.equal(
    run('git', ['worktree', 'list', '--porcelain'], repositoryRoot)
      .stdout.match(/^worktree /gm)?.length,
    1,
  );
  assert.equal(
    await readFile(join(repositoryRoot, 'feature.txt'), 'utf8'),
    'verified\n',
  );

  console.log('worktree management checks passed');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
