// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectRepo, grepRepo, validateRef } from '../src/collect/git.js';
import { ToolError } from '../src/errors.js';
import { LIMITS } from '../src/limits.js';
import { git, makeRepo, rm, tempDir, write } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rm(dirs.pop()!);
});

function repo(opts: { modifyRules?: boolean } = {}): string {
  const r = makeRepo(opts);
  dirs.push(r);
  return r;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as ToolError).code;
  }
}

describe('collectRepo', () => {
  it('collects commit subjects and bodies for merge-base..HEAD, newest first, no author/timestamp', async () => {
    const r = repo();
    // Add a second feature commit with a body carrying a trailer, so there are two commits past the base.
    write(r, 'src/users.ts', 'export const a = 1;\nexport const b = "x" + req.query.id;\nexport const c = 2;\n');
    git(r, 'commit', '-q', '-am', 'feat: add c\n\nExplains the change.\n\nFixes: ABC-123');
    const out = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    expect(out.commits.length).toBe(2);
    // Newest first.
    expect(out.commits[0].subject).toBe('feat: add c');
    expect(out.commits[0].body).toContain('Explains the change.');
    expect(out.commits[0].body).toContain('Fixes: ABC-123');
    expect(out.commits[1].subject).toBe('feature');
    // The base commit ("base") is below the merge-base and excluded.
    expect(out.commits.map((c) => c.subject)).not.toContain('base');
    // No author/email/timestamp leaks into the collected text.
    const text = JSON.stringify(out.commits);
    expect(text).not.toContain('test@example.com');
    expect(text).not.toContain('Test');
  });

  it('a single-line commit has no body field', async () => {
    const r = repo();
    const out = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    expect(out.commits).toHaveLength(1);
    expect(out.commits[0]).toEqual({ subject: 'feature' });
  });

  it('caps the commit count at 50 (newest kept)', async () => {
    const r = repo();
    for (let i = 0; i < 60; i++) {
      write(r, 'src/users.ts', `export const a = 1;\nexport const n = ${i};\n`);
      git(r, 'commit', '-q', '-am', `commit ${i}`);
    }
    const out = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    expect(out.commits).toHaveLength(50);
    // Newest kept: "commit 59" is present, the oldest "feature" is dropped.
    expect(out.commits[0].subject).toBe('commit 59');
    expect(out.commits.map((c) => c.subject)).not.toContain('feature');
  }, 30_000);

  it('caps the total commit bytes at 8 KB (bodies truncated/dropped oldest first)', async () => {
    const r = repo();
    // Two commits each with a large body; combined > 8 KB.
    write(r, 'src/users.ts', 'export const a = 1;\nexport const x = 1;\n');
    git(r, 'commit', '-q', '-am', `older\n\n${'A'.repeat(6000)}`);
    write(r, 'src/users.ts', 'export const a = 1;\nexport const y = 2;\n');
    git(r, 'commit', '-q', '-am', `newer\n\n${'B'.repeat(6000)}`);
    const out = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    const bytes = out.commits.reduce((n, c) => n + Buffer.byteLength(c.subject) + Buffer.byteLength(c.body ?? ''), 0);
    expect(bytes).toBeLessThanOrEqual(8_192);
    // Newest commit's body is preserved; the oldest body is truncated or dropped.
    expect(out.commits[0].subject).toBe('newer');
    expect(out.commits[0].body).toContain('B');
  });

  it('reads REVIEW.md from the merge-base when the branch modifies it', async () => {
    const r = repo({ modifyRules: true });
    const out = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    expect(out.mergeBase).toBe(git(r, 'rev-parse', 'mainline'));
    expect(out.rules.reviewMd).toContain('(base)');
    expect(out.rules.reviewMd).not.toContain('(head)');
    // The REVIEW.md edit itself is part of the reviewed diff.
    expect(out.diff).toContain('+# Review guidance (head)');
    expect(out.headSha).toBe(git(r, 'rev-parse', 'HEAD'));
    expect(out.headRef).toBe('feature');
  });

  it('uses the merge-base, not the base tip, when the base moved on', async () => {
    const r = repo();
    const fork = git(r, 'rev-parse', 'mainline');
    git(r, 'checkout', '-q', 'mainline');
    write(r, 'REVIEW.md', '# Review guidance (later)\n');
    git(r, 'commit', '-q', '-am', 'later');
    git(r, 'checkout', '-q', 'feature');
    const out = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    expect(out.mergeBase).toBe(fork);
    expect(out.rules.reviewMd).toContain('(base)');
  });

  it('sends 50 lines of context around a change', async () => {
    const r = repo();
    const lines = Array.from({ length: 200 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
    write(r, 'src/big.ts', lines.join('\n') + '\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add big');
    git(r, 'branch', 'base2');
    lines[99] = 'export const v100 = "changed";';
    write(r, 'src/big.ts', lines.join('\n') + '\n');
    git(r, 'commit', '-q', '-am', 'change line 100');
    const c = await collectRepo({ repoPath: r, base: 'base2', includeUncommitted: false, contextFiles: [] });
    expect(c.diff).toContain(' export const v50 = 50;');
    expect(c.diff).toContain(' export const v150 = 150;');
    expect(c.diff).not.toContain('\n export const v49 = 49;');
    expect(c.diff).not.toContain('\n export const v151 = 151;');
  });

  it('falls back to 3 lines of context when the 50-line diff is over the diff size limit', async () => {
    const r = repo();
    const lines = Array.from({ length: 60_000 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
    write(r, 'src/big.ts', lines.join('\n') + '\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add big');
    git(r, 'branch', 'base2');
    for (let i = 50; i < lines.length; i += 100) lines[i] = `export const v${i + 1} = "changed";`;
    write(r, 'src/big.ts', lines.join('\n') + '\n');
    git(r, 'commit', '-q', '-am', 'change every 100th line');
    const wide = execFileSync('git', ['-C', r, 'diff', '-U50', 'base2', 'HEAD'], {
      maxBuffer: 64 * 1024 * 1024,
    }).length;
    expect(wide).toBeGreaterThan(LIMITS.diffBytes);
    const c = await collectRepo({ repoPath: r, base: 'base2', includeUncommitted: false, contextFiles: [] });
    expect(Buffer.byteLength(c.diff)).toBeLessThan(LIMITS.diffBytes);
    expect(c.diff.match(/^@@ /gm)!.length).toBeGreaterThan(100);
  });

  it('includeUncommitted diffs the working tree; otherwise only commits', async () => {
    const r = repo();
    write(r, 'src/users.ts', 'export const a = 1;\nexport const b = "x" + req.query.id;\nexport const dirty = true;\n');
    write(r, 'untracked.ts', 'export const u = 1;\n');
    const committed = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [] });
    expect(committed.diff).not.toContain('dirty');
    const wt = await collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: true, contextFiles: [] });
    expect(wt.diff).toContain('+export const dirty = true;');
    expect(wt.diff).not.toContain('untracked.ts');
  });

  it('reads context files at HEAD', async () => {
    const r = repo();
    const out = await collectRepo({
      repoPath: r,
      base: 'mainline',
      includeUncommitted: false,
      contextFiles: ['docs/spec.md'],
    });
    expect(out.context).toEqual([{ path: 'docs/spec.md', content: '# Spec\n' }]);
  });

  it('base not found', async () => {
    const r = repo();
    expect(await codeOf(collectRepo({ repoPath: r, base: 'nope', includeUncommitted: false, contextFiles: [] }))).toBe(
      'BASE_NOT_FOUND',
    );
  });

  it('rejects a path-escape context file', async () => {
    const r = repo();
    const outside = tempDir('kcr-outside-');
    dirs.push(outside);
    write(outside, 'secret.txt', 'outside\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(r, 'link.txt'));
    for (const p of ['../outside.txt', 'link.txt', path.join(os.tmpdir(), 'x'), '.git/config']) {
      const code = await codeOf(
        collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: [p] }),
      );
      expect(['CONTEXT_PATH_INVALID', 'CONTEXT_NOT_FOUND']).toContain(code);
      if (p !== '../outside.txt') expect(code).toBe('CONTEXT_PATH_INVALID');
    }
  });

  it('rejects a binary context file', async () => {
    const r = repo();
    write(r, 'bin.dat', 'a\u0000b');
    git(r, 'add', 'bin.dat');
    git(r, 'commit', '-q', '-m', 'bin');
    expect(
      await codeOf(
        collectRepo({ repoPath: r, base: 'mainline', includeUncommitted: false, contextFiles: ['bin.dat'] }),
      ),
    ).toBe('CONTEXT_NOT_TEXT');
  });

  it('rejects a ref starting with "-" and unsupported characters', async () => {
    const r = repo();
    expect(
      await codeOf(collectRepo({ repoPath: r, base: '--output=/tmp/x', includeUncommitted: false, contextFiles: [] })),
    ).toBe('INVALID_REF');
    expect(() => validateRef('-x')).toThrow(ToolError);
    expect(() => validateRef('main;rm')).toThrow(ToolError);
    expect(() => validateRef('origin/mainline')).not.toThrow();
    expect(() => validateRef('HEAD~2')).not.toThrow();
  });

  it('requires the repository root and a non-empty diff', async () => {
    const r = repo();
    expect(
      await codeOf(
        collectRepo({ repoPath: path.join(r, 'src'), base: 'mainline', includeUncommitted: false, contextFiles: [] }),
      ),
    ).toBe('NOT_A_GIT_REPO');
    const notRepo = tempDir('kcr-norepo-');
    dirs.push(notRepo);
    expect(
      await codeOf(collectRepo({ repoPath: notRepo, base: 'mainline', includeUncommitted: false, contextFiles: [] })),
    ).toBe('NOT_A_GIT_REPO');
    expect(
      await codeOf(collectRepo({ repoPath: r, base: 'feature', includeUncommitted: false, contextFiles: [] })),
    ).toBe('EMPTY_DIFF');
  });
});

describe('grepRepo (regex by default)', () => {
  const head = (r: string) => git(r, 'rev-parse', 'HEAD');
  const matchLines = (out: string[]) => out.filter((l) => /^\S+:\d+: /.test(l));

  it('matches a plain string literally', async () => {
    const r = repo();
    const out = await grepRepo(r, head(r), 'req.query.id', false);
    expect(matchLines(out)).toEqual(['src/users.ts:2: export const b = "x" + req.query.id;']);
  });

  it('matches an extended-regex pattern', async () => {
    const r = repo();
    // POSIX ERE (git grep -E): alternation and a quantifier, not a literal substring of any line.
    const out = await grepRepo(r, head(r), 'export (const|let) [ab]', false);
    expect(out.map((l) => l.split(':')[0])).toContain('src/users.ts');
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('treats regex metacharacters as a pattern, not a literal', async () => {
    const r = repo();
    // `.` is any-char: `req.query` matches, and a pattern that cannot match returns nothing.
    expect(matchLines(await grepRepo(r, head(r), 'req.query', false))).toHaveLength(1);
    expect(await grepRepo(r, head(r), '^zzz nomatch$', false)).toHaveLength(0);
  });

  it('falls back to a literal search when the regex is malformed', async () => {
    const r = repo();
    write(r, 'src/users.ts', 'export const a = 1;\nexport const b = "x" + req.query.id;\nconst re = "a(b";\n');
    git(r, 'commit', '-q', '-am', 'add unbalanced literal');
    // `a(b` is an invalid ERE (unbalanced paren); it must still match the literal text.
    const out = await grepRepo(r, head(r), 'a(b', false);
    expect(out).toEqual([
      'src/users.ts-1- export const a = 1;',
      'src/users.ts-2- export const b = "x" + req.query.id;',
      'src/users.ts:3: const re = "a(b";',
    ]);
  });

  it('drops matches in denylisted paths', async () => {
    const r = repo();
    write(r, '.env', 'SECRET=const a = 1;\n');
    git(r, 'add', '-f', '.env');
    git(r, 'commit', '-q', '-m', 'add env');
    const out = await grepRepo(r, head(r), 'const a = 1', false);
    expect(out.every((l) => !l.startsWith('.env:'))).toBe(true);
  });
});
describe('grepRepo context lines', () => {
  const lines = (n: number, hit: number[]) =>
    Array.from({ length: n }, (_, i) => (hit.includes(i + 1) ? `call needle() ${i + 1}` : `line ${i + 1}`)).join('\n') +
    '\n';
  const head = (r: string) => git(r, 'rev-parse', 'HEAD').trim();

  it('returns 3 lines either side of each match, marks matches with ":" and context with "-", and splits blocks with "--"', async () => {
    const r = repo();
    write(r, 'src/a.ts', lines(20, [5, 16]));
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add a');
    expect(await grepRepo(r, head(r), 'needle', false)).toEqual([
      'src/a.ts-2- line 2',
      'src/a.ts-3- line 3',
      'src/a.ts-4- line 4',
      'src/a.ts:5: call needle() 5',
      'src/a.ts-6- line 6',
      'src/a.ts-7- line 7',
      'src/a.ts-8- line 8',
      '--',
      'src/a.ts-13- line 13',
      'src/a.ts-14- line 14',
      'src/a.ts-15- line 15',
      'src/a.ts:16: call needle() 16',
      'src/a.ts-17- line 17',
      'src/a.ts-18- line 18',
      'src/a.ts-19- line 19',
    ]);
  });

  it('merges overlapping windows and drops every line of a denylisted file', async () => {
    const r = repo();
    write(r, 'src/b.ts', lines(6, [2, 4]));
    write(r, 'config/.env', lines(3, [2]));
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add b');
    const out = await grepRepo(r, head(r), 'needle', false);
    expect(out).toEqual([
      'src/b.ts-1- line 1',
      'src/b.ts:2: call needle() 2',
      'src/b.ts-3- line 3',
      'src/b.ts:4: call needle() 4',
      'src/b.ts-5- line 5',
      'src/b.ts-6- line 6',
    ]);
  });

  it('ends at the 20th match and its trailing context, without leading context of a 21st', async () => {
    const r = repo();
    const hits = Array.from({ length: 21 }, (_, i) => 4 + i * 10);
    write(r, 'src/spread.ts', lines(220, hits));
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add spread');
    const out = await grepRepo(r, head(r), 'needle', false);
    expect(out.filter((l) => l.startsWith('src/spread.ts:'))).toHaveLength(20);
    expect(out.slice(-4)).toEqual([
      'src/spread.ts:194: call needle() 194',
      'src/spread.ts-195- line 195',
      'src/spread.ts-196- line 196',
      'src/spread.ts-197- line 197',
    ]);
  });

  it('stops at 20 matches', async () => {
    const r = repo();
    write(
      r,
      'src/many.ts',
      lines(
        30,
        Array.from({ length: 30 }, (_, i) => i + 1),
      ),
    );
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add many');
    const out = await grepRepo(r, head(r), 'needle', false);
    expect(out.filter((l) => l.startsWith('src/many.ts:'))).toHaveLength(20);
    expect(out.at(-1)).toBe('src/many.ts:20: call needle() 20');
  });
});

describe('grepRepo context with a regex', () => {
  it('marks only regex matches with ":" when context lines are included', async () => {
    const r = repo();
    write(r, 'src/re.ts', 'one\nfoo1\ntwo\nthree\nfoo2\nfour\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'add re');
    const out = await grepRepo(r, git(r, 'rev-parse', 'HEAD'), 'foo[0-9]', false);
    expect(out).toEqual([
      'src/re.ts-1- one',
      'src/re.ts:2: foo1',
      'src/re.ts-3- two',
      'src/re.ts-4- three',
      'src/re.ts:5: foo2',
      'src/re.ts-6- four',
    ]);
  });
});
