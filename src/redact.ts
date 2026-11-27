// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { HUNK_RE, unquotePath } from './collect/diffInfo.js';

/**
 * Secret redaction. Line-oriented; each pattern replaces only the secret
 * value with `[REDACTED:<type>]`. Linear-time regexes only; lines are matched in chunks of at most
 * 10,000 chars. Reported locations never carry the value.
 */

export type RedactionType =
  | 'aws-access-key-id'
  | 'aws-secret-access-key'
  | 'private-key'
  | 'github-token'
  | 'slack-token'
  | 'jwt'
  | 'generic-secret';

export interface RedactionLocation {
  type: RedactionType;
  file: string;
  line: number;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionLocation[];
}

export const LINE_MATCH_CAP = 10_000;

const marker = (type: RedactionType): string => `[REDACTED:${type}]`;

interface WholePattern {
  type: RedactionType;
  re: RegExp;
}

/** Patterns whose whole match is the secret value. */
const WHOLE_PATTERNS: WholePattern[] = [
  { type: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { type: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { type: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

const AWS_SECRET_RE =
  /(aws_?secret_?access_?key|aws_?secret|secretAccessKey)(["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})/gi;
const GENERIC_RE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{8,200})/gi;
const PLACEHOLDER_RES = [/^\$\{.*\}$/, /^<.*>$/, /^(x+|\*+)$/];
const PK_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PK_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;

function isPlaceholder(value: string): boolean {
  return value.startsWith('[REDACTED:') || PLACEHOLDER_RES.some((re) => re.test(value));
}

function redactChunk(chunk: string, found: RedactionType[]): string {
  let out = chunk;
  for (const p of WHOLE_PATTERNS) {
    out = out.replace(p.re, () => {
      found.push(p.type);
      return marker(p.type);
    });
  }
  out = out.replace(AWS_SECRET_RE, (_m, key: string, sep: string) => {
    found.push('aws-secret-access-key');
    return `${key}${sep}${marker('aws-secret-access-key')}`;
  });
  out = out.replace(GENERIC_RE, (m, prefix: string, value: string) => {
    if (isPlaceholder(value)) return m;
    found.push('generic-secret');
    return `${prefix}${marker('generic-secret')}`;
  });
  return out;
}

/** Redacts one line of content (no diff prefix). Returns the new text and the types found. */
export function redactLine(content: string): { text: string; types: RedactionType[] } {
  const types: RedactionType[] = [];
  if (content.length <= LINE_MATCH_CAP) return { text: redactChunk(content, types), types };
  let text = '';
  for (let i = 0; i < content.length; i += LINE_MATCH_CAP) {
    text += redactChunk(content.slice(i, i + LINE_MATCH_CAP), types);
  }
  return { text, types };
}

/** Stateful private-key block tracker shared by the diff and plain-text redactors. */
class PrivateKeyState {
  inBlock = false;

  /** Returns replacement content, or null when the line is not a key body line. */
  handle(content: string): { replace: string | null; begin: boolean } {
    if (!this.inBlock) {
      if (PK_BEGIN_RE.test(content)) {
        this.inBlock = !PK_END_RE.test(content.slice(content.search(PK_BEGIN_RE) + 11));
        return { replace: null, begin: true };
      }
      return { replace: null, begin: false };
    }
    if (PK_END_RE.test(content)) {
      this.inBlock = false;
      return { replace: null, begin: false };
    }
    return { replace: marker('private-key'), begin: false };
  }
}

/** Redacts a plain text file (context file or REVIEW.md); `line` is the 1-based file line. */
export function redactText(text: string, file: string): RedactionResult {
  const pk = new PrivateKeyState();
  const redactions: RedactionLocation[] = [];
  const lines = text.split('\n').map((content, i) => {
    const lineNo = i + 1;
    const state = pk.handle(content);
    if (state.begin) redactions.push({ type: 'private-key', file, line: lineNo });
    if (state.replace !== null) return state.replace;
    const r = redactLine(content);
    for (const type of r.types) redactions.push({ type, file, line: lineNo });
    return r.text;
  });
  return { text: lines.join('\n'), redactions };
}

/**
 * Redacts a unified diff. Header lines (diff --git, index, ---, +++, @@) are kept; only the content
 * of `+`, `-` and context lines is redacted, and the one-character prefix is preserved. A line is
 * reported with its new-side number for adds/context and its old-side number for deletes.
 */
export function redactDiff(diff: string): RedactionResult {
  const redactions: RedactionLocation[] = [];
  let file = '';
  let oldPath = '';
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let pkNew = new PrivateKeyState();
  let pkOld = new PrivateKeyState();
  const out = diff.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      pkNew = new PrivateKeyState();
      pkOld = new PrivateKeyState();
      const rest = line.slice('diff --git '.length);
      const idx = rest.lastIndexOf(' b/');
      file = idx >= 0 ? unquotePath(rest.slice(idx + 1)).replace(/^b\//, '') : rest;
      oldPath = file;
      return line;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      return line;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = unquotePath(line.slice(4).trim());
        if (p !== '/dev/null') oldPath = p.replace(/^a\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = unquotePath(line.slice(4).trim());
        file = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
      }
      return line;
    }
    const prefix = line[0];
    if (prefix !== '+' && prefix !== '-' && prefix !== ' ') return line; // "\ No newline at end of file", blank
    const content = line.slice(1);
    const isDelete = prefix === '-';
    const lineNo = isDelete ? oldLine : newLine;
    const reportFile = isDelete ? oldPath : file;
    if (prefix === '+') newLine++;
    else if (prefix === '-') oldLine++;
    else {
      oldLine++;
      newLine++;
    }
    // Track key blocks per side: context lines feed both sides.
    const states = prefix === '+' ? [pkNew] : prefix === '-' ? [pkOld] : [pkNew, pkOld];
    const results = states.map((s) => s.handle(content));
    if (results.some((r) => r.begin)) redactions.push({ type: 'private-key', file: reportFile, line: lineNo });
    if (results.some((r) => r.replace !== null)) return `${prefix}${marker('private-key')}`;
    const r = redactLine(content);
    for (const type of r.types) redactions.push({ type, file: reportFile, line: lineNo });
    return `${prefix}${r.text}`;
  });
  return { text: out.join('\n'), redactions };
}
