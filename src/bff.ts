// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cbor } from '@smithy/core/cbor';
import { ToolError } from './errors.js';

/**
 * The Kiro BFF over Smithy RPC v2 CBOR: `POST <endpoint>/service/KiroWebBearerService/operation/<Op>` with a CBOR
 * body. An API key is a "machine" identity, so it sends `Authorization: Bearer <key>` and `TokenType: API_KEY`.
 * Failed calls throw a ToolError('SERVICE_ERROR') whose details carry `httpStatus` and a `serviceCode`.
 */

/** The Kiro BFF in prod (us-east-1). */
export const DEFAULT_ENDPOINT = 'https://app.kiro.dev';

/**
 * Prod BFF origin per region. us-east-1 is the bare host; other regions are `<region>.app.kiro.dev`.
 * `fra` is an accepted alias for eu-central-1 (Frankfurt).
 */
export const REGION_ENDPOINTS: Record<string, string> = {
  'us-east-1': DEFAULT_ENDPOINT,
  'eu-central-1': 'https://eu-central-1.app.kiro.dev',
  fra: 'https://eu-central-1.app.kiro.dev',
};

/** Resolves a region input to its prod BFF origin, or throws CONFIG_INVALID_REGION. */
export function endpointForRegion(region: string): string {
  const endpoint = REGION_ENDPOINTS[region.trim().toLowerCase()];
  if (endpoint === undefined) {
    throw new ToolError(
      'CONFIG_INVALID_REGION',
      `Unknown region "${region}". Use ${Object.keys(REGION_ENDPOINTS).join(', ')}.`,
    );
  }
  return endpoint;
}
const OPERATION_PATH = '/service/KiroWebBearerService/operation';
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 500;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const USER_AGENT = 'kiro-reviewer-action';

export interface BffConfig {
  /** A bare https origin, no trailing slash. */
  endpoint: string;
  apiKey: string;
}

/** Validates the endpoint (the key is sent there) and the key. Both are required at this trust boundary. */
export function loadBffConfig(raw: {
  endpoint?: string;
  region?: string;
  apiKey?: string;
  allowCustomEndpoint?: boolean;
}): BffConfig {
  const explicitEndpoint = (raw.endpoint ?? '').trim();
  const region = (raw.region ?? '').trim();
  // region picks a known prod host; endpoint is the escape hatch for other stages. Setting both to
  // different hosts is ambiguous about where the key goes, so it is rejected rather than guessed.
  let endpointRaw: string;
  if (explicitEndpoint !== '' && region !== '') {
    if (endpointForRegion(region) !== explicitEndpoint) {
      throw new ToolError('CONFIG_INVALID_ENDPOINT', 'Set either region or endpoint, not both with different hosts.');
    }
    endpointRaw = explicitEndpoint;
  } else if (region !== '') {
    endpointRaw = endpointForRegion(region);
  } else {
    endpointRaw = explicitEndpoint || DEFAULT_ENDPOINT;
  }
  let url: URL;
  try {
    url = new URL(endpointRaw);
  } catch {
    throw new ToolError('CONFIG_INVALID_ENDPOINT', 'The endpoint input is not a valid URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new ToolError(
      'CONFIG_INVALID_ENDPOINT',
      'The endpoint must be an https origin such as https://app.kiro.dev.',
    );
  }
  // A workflow edit must not be able to send the key to an arbitrary host.
  if (!raw.allowCustomEndpoint && !Object.values(REGION_ENDPOINTS).includes(url.origin)) {
    throw new ToolError(
      'CONFIG_UNKNOWN_ENDPOINT',
      `The endpoint ${url.origin} is not a Kiro origin. Set allow-custom-endpoint: true to use it.`,
    );
  }
  const apiKey = (raw.apiKey ?? '').trim();
  if (apiKey === '') {
    throw new ToolError(
      'CONFIG_MISSING_API_KEY',
      'No Kiro API key. Set the kiro-api-key input (or KIRO_API_KEY) from a repository secret.',
    );
  }
  if (/\s/.test(apiKey)) {
    throw new ToolError(
      'CONFIG_INVALID_API_KEY',
      'The Kiro API key contains whitespace. Re-save the secret without a newline.',
    );
  }
  return { endpoint: url.origin, apiKey };
}

export interface BffDeps {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const retryableStatus = (s: number): boolean => s === 429 || s >= 500;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/** Drops `undefined` members, which CBOR would encode as a value. */
function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compact);
  if (v !== null && typeof v === 'object') {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = compact(x);
    return out;
  }
  return v;
}

/** `Namespace#Name` or `Name` to `Name`. */
const shortName = (type: unknown): string | undefined =>
  typeof type === 'string' && type !== '' ? type.split('#').pop()!.split(':')[0] : undefined;

/**
 * The stable code an error maps to. A conflict carries its reason (ITERATION_IN_PROGRESS and so on). Other errors
 * map to the names the reviewer service used, which the caller's recovery logic is written against.
 */
export function serviceCodeOf(status: number, body: unknown): string {
  const b = rec(body);
  const name = shortName(b.__type);
  switch (name) {
    case 'CodeReviewConflictException':
      return typeof b.reason === 'string' && /^[A-Z_]{3,64}$/.test(b.reason) ? b.reason : 'CONFLICT';
    case 'ResourceNotFoundException':
      return 'NOT_FOUND';
    case 'BadRequestException':
    case 'ValidationException':
      return 'VALIDATION_ERROR';
    case 'UnauthorizedException':
      return 'UNAUTHORIZED';
    case 'ForbiddenException':
    case 'AccessDeniedException':
    case 'AccountSuspendedException':
      return 'ACCESS_DENIED';
    case 'ThrottlingException':
      return 'THROTTLED';
  }
  if (name) return name;
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'ACCESS_DENIED';
  return `HTTP_${status}`;
}

function decode(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return null;
  try {
    return cbor.deserialize(bytes);
  } catch {
    return null;
  }
}

function serviceError(status: number, body: unknown): ToolError {
  const serviceCode = serviceCodeOf(status, body);
  const message = rec(body).message;
  const text =
    serviceCode === 'UNAUTHORIZED'
      ? 'The Kiro API key was rejected.'
      : typeof message === 'string'
        ? message
        : `HTTP ${status}`;
  return new ToolError('SERVICE_ERROR', `${serviceCode}: ${text.slice(0, 300)}`, { httpStatus: status, serviceCode });
}

/** The host a redirect points at, for the error message. Only a plain hostname is shown; the rest is dropped. */
export function redirectHost(location: string | null): string | null {
  if (!location) return null;
  try {
    const host = new URL(location).hostname;
    return /^[a-z0-9.-]{1,100}$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Calls one operation. Network errors, 429 and 5xx are retried (3 attempts, 500 ms x 2^k plus jitter); every
 * operation the Action uses is a read, idempotent, or carries a clientToken, so a retry is safe. Redirects are
 * refused so the key never reaches another host.
 */
export async function bffCall<T = unknown>(
  config: BffConfig,
  operation: string,
  input: object,
  deps: BffDeps = { fetch },
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const body = cbor.serialize(compact(input));
  let last: ToolError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(random() * 100));
    let res: Response;
    try {
      res = await deps.fetch(`${config.endpoint}${OPERATION_PATH}/${operation}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/cbor',
          accept: 'application/cbor',
          'smithy-protocol': 'rpc-v2-cbor',
          authorization: `Bearer ${config.apiKey}`,
          TokenType: 'API_KEY',
          'user-agent': USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      last = new ToolError('NETWORK_ERROR', 'The Kiro service could not be reached.');
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      const to = redirectHost(res.headers.get('location'));
      throw new ToolError(
        'SERVICE_ERROR',
        `REDIRECT: The endpoint redirected${to ? ` to ${to}` : ''} (HTTP ${res.status}); refusing to follow it. ` +
          'The request did not reach the service.',
        {
          httpStatus: res.status,
          serviceCode: 'REDIRECT',
        },
      );
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_RESPONSE_BYTES)
      throw new ToolError('SERVICE_ERROR', 'RESPONSE_TOO_LARGE: The reply is too large.');
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      last = new ToolError('NETWORK_ERROR', 'The Kiro service reply could not be read.');
      continue;
    }
    if (bytes.length > MAX_RESPONSE_BYTES)
      throw new ToolError('SERVICE_ERROR', 'RESPONSE_TOO_LARGE: The reply is too large.');
    const parsed = decode(bytes);
    if (res.status >= 200 && res.status < 300) {
      if (res.headers.get('smithy-protocol') !== 'rpc-v2-cbor' || parsed === null) {
        throw new ToolError('SERVICE_ERROR', 'BAD_REPLY: The reply was not a Kiro service response.', {
          httpStatus: res.status,
          serviceCode: 'BAD_REPLY',
        });
      }
      return parsed as T;
    }
    const err = serviceError(res.status, parsed);
    if (!retryableStatus(res.status)) throw err;
    last = err;
  }
  throw last ?? new ToolError('NETWORK_ERROR', 'The Kiro service could not be reached.');
}
