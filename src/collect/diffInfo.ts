// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Light-weight unified diff scanning for the summary, limits and redaction line numbers. */

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

export interface DiffFileInfo {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  added: number;
  removed: number;
}

export interface DiffInfo {
  files: DiffFileInfo[];
  changedLines: number;
}

/** Decodes a git C-style quoted path (`"a/x\tb"`, octal UTF-8 bytes). Unquoted input is returned as is. */
export function unquotePath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string | null {
  const u = unquotePath(p.trim());
  if (u === '/dev/null') return null;
  return u.startsWith(prefix) ? u.slice(2) : u;
}

/** Fallback when no ---/+++/rename lines exist (binary or mode-only changes). */
function headerPaths(line: string): { a: string; b: string } {
  const rest = line.slice('diff --git '.length);
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) return { a: rest, b: rest };
  return { a: stripPrefix(rest.slice(0, idx), 'a/') ?? rest, b: stripPrefix(rest.slice(idx + 1), 'b/') ?? rest };
}

export const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function scanDiff(diff: string): DiffInfo {
  const files: DiffFileInfo[] = [];
  let cur: DiffFileInfo | null = null;
  let inHunk = false;
  let changedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const hp = headerPaths(line);
      cur = { path: hp.b, oldPath: hp.a, status: 'modified', added: 0, removed: 0 };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        cur.status = 'renamed';
        cur.oldPath = unquotePath(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) cur.path = unquotePath(line.slice('rename to '.length));
      else if (line.startsWith('Binary files ')) cur.status = 'binary';
      else if (line.startsWith('--- ')) cur.oldPath = stripPrefix(line.slice(4), 'a/');
      else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4), 'b/');
        if (p !== null) cur.path = p;
        else if (cur.oldPath !== null) cur.path = cur.oldPath;
      } else if (HUNK_RE.test(line)) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      cur.added++;
      changedLines++;
    } else if (line.startsWith('-')) {
      cur.removed++;
      changedLines++;
    }
  }
  return { files, changedLines };
}
