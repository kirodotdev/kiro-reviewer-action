// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/collect/payload.js';

const SHA = 'b'.repeat(40);

describe('buildPayload rules', () => {
  it('sends REVIEW_RULES.yaml as the autosdeYaml wire field', () => {
    const p = buildPayload({
      baseRef: 'origin/mainline',
      mergeBase: SHA,
      headRef: 'feature',
      headSha: 'c'.repeat(40),
      includeUncommitted: false,
      diff: 'diff --git a/x b/x\n',
      rules: { reviewRulesYaml: 'custom-rules: []\n' },
      context: [],
      repo: 'r',
      clientVersion: '0.1.0',
      clientToken: 'f'.repeat(32),
    });
    expect(p.rules).toEqual({ source: 'base', revision: SHA, autosdeYaml: 'custom-rules: []\n' });
  });
});
