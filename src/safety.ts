// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Client-side path safety for reviewer context requests. Every path the service asks
 * for, and every extra file, goes through checkRequestPath before anything is read. Refused requests
 * are answered `declined` and the local reason is shown in the approval summary.
 */

/**
 * Secret-like paths that are never read, listed in a manifest or returned by a search
 * (all checks case-insensitive):
 * - basename `.env` or `.env.*`;
 * - extensions `.pem .key .p12 .pfx .jks .keystore .ppk .tfstate`;
 * - basename `id_*` without a further dot, optionally `.pub` (`id_rsa`, `id_ed25519.pub`; not `id_generator.ts`);
 * - any path segment `.aws`, `.ssh`, `.gnupg`, `.kube`, `.docker`;
 * - basename `credentials` / `credentials.*`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `secret(s)` / `secret(s).*`.
 */
export const SECRET_PATH_DENYLIST = {
  basenamePatterns: [
    /^\.env$/,
    /^\.env\..*$/,
    /^id_[^.]*(\.pub)?$/,
    /^credentials(\..*)?$/,
    /^\.netrc$/,
    /^\.npmrc$/,
    /^\.pypirc$/,
    /^\.git-credentials$/,
    /^secrets?(\.|$)/,
  ],
  extensions: ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.tfstate'],
  segments: ['.aws', '.ssh', '.gnupg', '.kube', '.docker'],
} as const;

/** True when a repo-relative POSIX path matches the secret denylist. */
export function isDeniedPath(posix: string): boolean {
  const segments = posix.toLowerCase().split('/');
  const base = segments[segments.length - 1] ?? '';
  if (segments.some((s) => (SECRET_PATH_DENYLIST.segments as readonly string[]).includes(s))) return true;
  if (SECRET_PATH_DENYLIST.extensions.some((ext) => base.endsWith(ext))) return true;
  return SECRET_PATH_DENYLIST.basenamePatterns.some((re) => re.test(base));
}

export type PathRefusal = 'INVALID_PATH' | 'OUTSIDE_REPO' | 'GIT_DIR' | 'DENYLISTED' | 'NOT_FOUND';
export type PathCheck = { ok: true; posix: string } | { ok: false; reason: PathRefusal };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isGitDir = (posix: string): boolean => posix.split('/')[0]?.toLowerCase() === '.git';

/**
 * Same path-format rules as the service (pathFormatViolation): non-empty, no control characters,
 * not absolute, no backslash, no `..` segment. Used to filter manifest entries.
 */
export function isWellFormedPath(rel: string): boolean {
  return (
    rel.length > 0 &&
    !CONTROL_RE.test(rel) &&
    !rel.startsWith('/') &&
    !path.isAbsolute(rel) &&
    !rel.includes('\\') &&
    !rel.split('/').includes('..')
  );
}

/**
 * Validates a requested repo-relative path against the repository toplevel `top` (already a
 * realpath). The denylist and .git/ checks run on both the requested and the resolved path, so a
 * symlink cannot launder a secret-like target.
 */
export function checkRequestPath(top: string, rel: string): PathCheck {
  if (!isWellFormedPath(rel) || rel.startsWith('~')) return { ok: false, reason: 'INVALID_PATH' };
  if (isGitDir(rel)) return { ok: false, reason: 'GIT_DIR' };
  if (isDeniedPath(rel)) return { ok: false, reason: 'DENYLISTED' };
  let real: string;
  try {
    real = realpathSync(path.resolve(top, rel));
  } catch {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  const relReal = path.relative(top, real);
  if (relReal === '' || relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal)) {
    return { ok: false, reason: 'OUTSIDE_REPO' };
  }
  const posix = relReal.split(path.sep).join('/');
  if (isGitDir(posix)) return { ok: false, reason: 'GIT_DIR' };
  if (isDeniedPath(posix)) return { ok: false, reason: 'DENYLISTED' };
  try {
    if (!statSync(real).isFile()) return { ok: false, reason: 'NOT_FOUND' };
  } catch {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  return { ok: true, posix };
}
