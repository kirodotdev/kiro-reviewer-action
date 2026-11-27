// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A failure with a stable code. Messages are fixed text or name only
 * non-sensitive values (limit names, profile names); they never carry repository content.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
