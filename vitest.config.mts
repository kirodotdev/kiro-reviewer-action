// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/build/**', '**/dist/**', '**/dist-bundle/**'],
    passWithNoTests: true,
    silent: 'passed-only',
    coverage: {
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
