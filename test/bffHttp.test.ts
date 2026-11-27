// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cbor } from '@smithy/core/cbor';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bffCall, type BffConfig } from '../src/bff.js';

/** The real `fetch` against a local server, for the parts a fake `fetch` cannot show. */
describe('bffCall over real HTTP', () => {
  let server: http.Server;
  let config: BffConfig;
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Uint8Array }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)) });
        if (req.url?.endsWith('/Redirect')) {
          res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
          res.end();
          return;
        }
        if (req.url?.endsWith('/Fail')) {
          res.writeHead(409, { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor' });
          res.end(
            Buffer.from(
              cbor.serialize({
                __type: 'ns#CodeReviewConflictException',
                message: 'm',
                reason: 'IDEMPOTENCY_CONFLICT',
              }),
            ),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor' });
        res.end(Buffer.from(cbor.serialize({ ok: true, createdAt: 1763424000000, list: [1, 2] })));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    config = {
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: 'ksk_exampleexampleexample',
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('round-trips a CBOR call with the identity headers', async () => {
    const out = await bffCall<{ ok: boolean; createdAt: number; list: number[] }>(config, 'GetCodeReview', {
      reviewId: 'rev-1',
      n: 3,
    });
    expect(out).toEqual({ ok: true, createdAt: 1763424000000, list: [1, 2] });
    const s = seen.at(-1)!;
    expect(s.url).toBe('/service/KiroWebBearerService/operation/GetCodeReview');
    expect(s.headers).toMatchObject({
      authorization: 'Bearer ksk_exampleexampleexample',
      tokentype: 'API_KEY',
      'smithy-protocol': 'rpc-v2-cbor',
      'content-type': 'application/cbor',
    });
    expect(cbor.deserialize(s.body)).toEqual({ reviewId: 'rev-1', n: 3 });
  });

  it('gets the 3xx response back, refuses it, and sends the key once', async () => {
    const before = seen.length;
    await expect(bffCall(config, 'Redirect', {})).rejects.toMatchObject({
      message: expect.stringContaining('redirected to 127.0.0.1'),
      details: { serviceCode: 'REDIRECT', httpStatus: 302 },
    });
    expect(seen.length - before).toBe(1);
  });

  it('reads a conflict reason from a real error reply', async () => {
    await expect(bffCall(config, 'Fail', {})).rejects.toMatchObject({
      details: { serviceCode: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 },
    });
  });
});
