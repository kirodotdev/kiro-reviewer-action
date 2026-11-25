// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rm(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

export function write(repo: string, rel: string, content: string): void {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A repo with `mainline` (REVIEW.md v1, src/users.ts) and `feature` checked out with changes. */
export function makeRepo(opts: { modifyRules?: boolean } = {}): string {
  const repo = tempDir('kcr-git-');
  git(repo, 'init', '-q', '-b', 'mainline');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'REVIEW.md', '# Review guidance (base)\n');
  write(repo, 'src/users.ts', 'export const a = 1;\n');
  write(repo, 'docs/spec.md', '# Spec\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'src/users.ts', 'export const a = 1;\nexport const b = "x" + req.query.id;\n');
  if (opts.modifyRules) write(repo, 'REVIEW.md', '# Review guidance (head)\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feature');
  return repo;
}
