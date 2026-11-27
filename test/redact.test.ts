// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { LINE_MATCH_CAP, redactDiff, redactLine, redactText } from '../src/redact.js';

const AKID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('redactLine patterns', () => {
  const cases: Array<[string, string, string]> = [
    ['aws-access-key-id', `const id = "${AKID}";`, 'const id = "[REDACTED:aws-access-key-id]";'],
    [
      'aws-secret-access-key',
      `aws_secret_access_key = ${SECRET}`,
      'aws_secret_access_key = [REDACTED:aws-secret-access-key]',
    ],
    ['github-token', `token ghp_${'a'.repeat(36)} end`, 'token [REDACTED:github-token] end'],
    ['github-token', `x github_pat_${'B'.repeat(22)}`, 'x [REDACTED:github-token]'],
    ['slack-token', 'hook xoxb-1234567890-abcdef', 'hook [REDACTED:slack-token]'],
    ['jwt', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'auth [REDACTED:jwt]'],
    ['generic-secret', 'password: "hunter2hunter2"', 'password: "[REDACTED:generic-secret]"'],
    ['generic-secret', 'API_KEY=abcdef123456', 'API_KEY=[REDACTED:generic-secret]'],
  ];
  for (const [type, input, expected] of cases) {
    it(`redacts ${type} value only: ${input.slice(0, 20)}`, () => {
      const r = redactLine(input);
      expect(r.text).toBe(expected);
      expect(r.types).toContain(type);
    });
  }

  it('skips placeholders', () => {
    for (const line of [
      'password: ${DB_PASSWORD}',
      'token = <your-token-here>',
      'secret: xxxxxxxxxx',
      'pwd=********',
    ]) {
      expect(redactLine(line).types).toEqual([]);
      expect(redactLine(line).text).toBe(line);
    }
  });

  it('does not double-report an AWS key already redacted', () => {
    const r = redactLine(`access_key = ${AKID}`);
    expect(r.text).toBe('access_key = [REDACTED:aws-access-key-id]');
    expect(r.types).toEqual(['aws-access-key-id']);
  });

  it('scans lines longer than the per-match cap in chunks', () => {
    const line = 'a'.repeat(LINE_MATCH_CAP + 5) + ` ${AKID}`;
    const r = redactLine(line);
    expect(r.text.endsWith('[REDACTED:aws-access-key-id]')).toBe(true);
  });
});

describe('redactDiff', () => {
  const diff = [
    'diff --git a/src/config.ts b/src/config.ts',
    'index 1111111..2222222 100644',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -10,3 +10,4 @@ export const cfg = {',
    '   region: "us-west-2",',
    `-  key: "${AKID}",`,
    `+  password: "supersecretvalue",`,
    '+  other: 1,',
    '   end: true,',
    '',
  ].join('\n');

  it('keeps headers and prefixes and reports locations without values', () => {
    const r = redactDiff(diff);
    const lines = r.text.split('\n');
    expect(lines.slice(0, 5)).toEqual(diff.split('\n').slice(0, 5));
    expect(lines[6]).toBe('-  key: "[REDACTED:aws-access-key-id]",');
    expect(lines[7]).toBe('+  password: "[REDACTED:generic-secret]",');
    expect(lines[8]).toBe('+  other: 1,');
    expect(r.redactions).toEqual([
      { type: 'aws-access-key-id', file: 'src/config.ts', line: 11 },
      { type: 'generic-secret', file: 'src/config.ts', line: 11 },
    ]);
    expect(JSON.stringify(r.redactions)).not.toContain('supersecret');
    expect(r.text).not.toContain(AKID);
  });

  it('replaces private key body lines statefully', () => {
    const d = [
      'diff --git a/k.pem b/k.pem',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/k.pem',
      '@@ -0,0 +1,4 @@',
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEpAIBAAKCAQEA1234',
      '+abcdefghijklmnop',
      '+-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = redactDiff(d);
    expect(r.text.split('\n').slice(5)).toEqual([
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+[REDACTED:private-key]',
      '+[REDACTED:private-key]',
      '+-----END RSA PRIVATE KEY-----',
    ]);
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.pem', line: 1 }]);
  });
});

describe('redactText', () => {
  it('reports file line numbers', () => {
    const r = redactText(`line1\nsecret = abcdefgh12345\n`, 'docs/a.md');
    expect(r.text).toBe('line1\nsecret = [REDACTED:generic-secret]\n');
    expect(r.redactions).toEqual([{ type: 'generic-secret', file: 'docs/a.md', line: 2 }]);
  });
});
