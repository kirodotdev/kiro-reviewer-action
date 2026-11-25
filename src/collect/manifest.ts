// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { charCount, LIMITS } from '../limits.js';
import { isDeniedPath, isWellFormedPath } from '../safety.js';

/**
 * File manifest for reviewer context requests: tracked path names only, never content.
 * Malformed, over-long and denylisted paths are dropped; the rest are ordered by how close they are
 * to a changed file (longest shared directory prefix, then lexicographic) and capped.
 */

const dirSegments = (p: string): string[] => p.split('/').slice(0, -1);

/** Number of leading directory segments `a` and `b` share. */
function sharedDirDepth(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export function buildManifest(
  trackedPaths: readonly string[],
  changedPaths: readonly string[],
  cap: number = LIMITS.manifestPaths,
): string[] {
  const changedDirs = changedPaths.map(dirSegments);
  const scored = [...new Set(trackedPaths)]
    .filter((p) => isWellFormedPath(p) && charCount(p) <= LIMITS.pathChars && !isDeniedPath(p))
    .map((p) => {
      const dirs = dirSegments(p);
      return { p, score: changedDirs.reduce((best, c) => Math.max(best, sharedDirDepth(dirs, c)), 0) };
    });
  scored.sort((x, y) => y.score - x.score || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
  return scored.slice(0, cap).map((s) => s.p);
}
