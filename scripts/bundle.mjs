// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Bundles the GitHub Action (dist/index.mjs) with every dependency inlined.
/* global console */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(import.meta.dirname);
const outDir = path.join(root, 'dist');

rmSync(outDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(outDir, 'index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  keepNames: true,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('bundle: src/main.ts -> dist/index.mjs');
