// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { existsSync, realpathSync, rmSync, statSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolError } from '../errors.js';
import type { LimitName } from '../limits.js';
import { limitExceeded, LIMITS, utf8Bytes } from '../limits.js';
import { isDeniedPath, isWellFormedPath } from '../safety.js';

/**
 * Git collection for the review payload. Git runs through execFile with an
 * argument array (never a shell), a 2 MB output cap and a 30 s timeout.
 */

export const GIT_MAX_BUFFER = 2 * 1024 * 1024;
export const GIT_TIMEOUT_MS = 30_000;
export const REF_RE = /^[A-Za-z0-9._/@^~-]{1,200}$/;

/** Lines of context around each change, widest first. The first diff within the size limit is used. */
const DIFF_CONTEXT_TIERS = [50, 6, 3];

export function validateRef(ref: string): void {
  if (!REF_RE.test(ref) || ref.startsWith('-')) {
    throw new ToolError('INVALID_REF', 'The base ref has an unsupported format.');
  }
}

class GitFailure extends Error {
  override readonly name = 'GitFailure';
  constructor(
    readonly stderr: string,
    readonly overflow: boolean,
  ) {
    super('git failed');
  }
}

/** Runs git and returns raw stdout bytes. */
function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotepath=on', ...args],
      {
        encoding: 'buffer',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          reject(
            new GitFailure(Buffer.from(stderr ?? '').toString('utf8'), code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function gitText(cwd: string, args: string[], overflowLimit: LimitName = 'diff.bytes'): Promise<string> {
  try {
    return (await git(cwd, args)).toString('utf8');
  } catch (e) {
    if (e instanceof GitFailure && e.overflow) throw limitExceeded(overflowLimit, GIT_MAX_BUFFER, GIT_MAX_BUFFER + 1);
    throw e;
  }
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 text without NUL, else null. */
function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return utf8Fatal.decode(buf);
  } catch {
    return null;
  }
}

export interface CollectInput {
  repoPath: string;
  base: string;
  includeUncommitted: boolean;
  contextFiles: readonly string[];
}

export interface CollectedRepo {
  toplevel: string;
  repoName: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  mergeBase: string;
  diff: string;
  rules: { reviewMd?: string };
  context: Array<{ path: string; content: string }>;
  /** Commit subjects/bodies for merge-base..HEAD, newest first; author/email/timestamp excluded. */
  commits: Array<{ subject: string; body?: string }>;
}

async function showRuleFile(top: string, mergeBase: string, name: string): Promise<string | undefined> {
  try {
    return await gitText(top, ['show', `${mergeBase}:${name}`], 'rules.reviewMdBytes');
  } catch (e) {
    if (e instanceof GitFailure && /does not exist|exists on disk, but not in/.test(e.stderr)) return undefined;
    if (e instanceof ToolError) throw e;
    throw new ToolError('GIT_ERROR', `git show failed for the base ${name}.`);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Resolves a context path inside the toplevel (realpath containment, not under .git/). */
function resolveContextPath(top: string, rel: string): string {
  if (rel.length === 0 || path.isAbsolute(rel) || rel.includes('\\') || CONTROL_RE.test(rel)) {
    throw new ToolError('CONTEXT_PATH_INVALID', 'A context path must be a relative path inside the repository.');
  }
  const abs = path.resolve(top, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new ToolError('CONTEXT_NOT_FOUND', 'A context file does not exist.');
  }
  const relReal = path.relative(top, real);
  if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new ToolError('CONTEXT_PATH_INVALID', 'A context path resolves outside the repository.');
  }
  const posix = relReal.split(path.sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) {
    throw new ToolError('CONTEXT_PATH_INVALID', 'A context path must not be under .git/.');
  }
  if (!statSync(real).isFile()) throw new ToolError('CONTEXT_NOT_FOUND', 'A context path is not a regular file.');
  return posix;
}

export interface OpenedRepo {
  /** Realpath of the repository toplevel. */
  top: string;
  headSha: string;
}

/** Collection steps 1 and 3: repoPath must be the toplevel; resolves HEAD. */
export async function openRepo(repoPath: string): Promise<OpenedRepo> {
  let realRepo: string;
  try {
    realRepo = realpathSync(repoPath);
  } catch {
    throw new ToolError('NOT_A_GIT_REPO', 'repoPath does not exist.');
  }
  let top: string;
  try {
    top = (await gitText(realRepo, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new ToolError('NOT_A_GIT_REPO', 'repoPath is not a git repository.');
  }
  if (realpathSync(top) !== realRepo) {
    throw new ToolError('NOT_A_GIT_REPO', 'repoPath must be the repository root (git rev-parse --show-toplevel).');
  }
  let headSha: string;
  try {
    headSha = (await gitText(realRepo, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])).trim();
  } catch {
    throw new ToolError('GIT_ERROR', 'The repository has no HEAD commit.');
  }
  return { top: realRepo, headSha };
}

/** Tracked paths at HEAD (`git ls-tree`), or in the index with includeUncommitted (`git ls-files`). */
export async function listTrackedFiles(top: string, headSha: string, includeUncommitted: boolean): Promise<string[]> {
  const args = includeUncommitted ? ['ls-files', '-z'] : ['ls-tree', '-r', '--name-only', '-z', headSha];
  let out: string;
  try {
    out = await gitText(top, args, 'manifest.paths');
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('GIT_ERROR', 'Listing tracked files failed.');
  }
  return out.split('\0').filter((p) => p.length > 0);
}

/**
 * Reads a checked repo-relative file: from the working tree with includeUncommitted, else at HEAD.
 * Returns null when the file is not committed at HEAD or missing. Over 2 MB → LIMIT_EXCEEDED context.fileBytes.
 */
export async function readRepoFile(
  top: string,
  headSha: string,
  posix: string,
  includeUncommitted: boolean,
): Promise<Buffer | null> {
  if (includeUncommitted) {
    const file = path.join(top, ...posix.split('/'));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return null;
    }
    if (size > GIT_MAX_BUFFER) throw limitExceeded('context.fileBytes', GIT_MAX_BUFFER, size);
    return readFileSync(file);
  }
  try {
    return await git(top, ['show', `${headSha}:${posix}`]);
  } catch (e) {
    if (e instanceof GitFailure && e.overflow)
      throw limitExceeded('context.fileBytes', GIT_MAX_BUFFER, GIT_MAX_BUFFER + 1);
    return null;
  }
}

/** Decodes repository bytes as UTF-8 text (no NUL), else null. */
export const decodeRepoText = (buf: Buffer): string | null => decodeText(buf);

export const GREP_MAX_MATCHES = 20;
export const GREP_CONTEXT_LINES = 6;
/** Most lines of enclosing-function context kept either side of a match. */
export const GREP_FUNCTION_LINES = 40;
export const GREP_LINE_CHARS = 200;
export const GREP_MAX_BYTES = 32 * 1024;

/** git's built-in function-name drivers by file extension, plus `kcrjs` for JavaScript and TypeScript. */
const GREP_FUNC_DRIVERS: Record<string, string[]> = {
  kcrjs: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyi'],
  golang: ['go'],
  rust: ['rs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  csharp: ['cs'],
  cpp: ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  objc: ['m', 'mm'],
  ruby: ['rb'],
  php: ['php'],
  bash: ['sh', 'bash', 'zsh'],
  perl: ['pl', 'pm'],
  elixir: ['ex', 'exs'],
  css: ['css', 'scss', 'less'],
  html: ['html', 'htm'],
  markdown: ['md'],
};

/**
 * Function starts for JavaScript and TypeScript: functions, classes, arrow-function bindings, type declarations,
 * methods and test blocks. A method with no modifier must end in `) {` or `): Type {`, so a call statement such as
 * `run(x);` or `run(x, {` is not a function start. A binding must be followed by `=>`, `function` or an open
 * parameter list, so `const n = (a + b) * 2;` is not one either. The `!` line excludes control-flow statements.
 */
const KCRJS_FUNCNAME = [
  '!^[ \t]*(if|else|for|while|do|switch|case|catch|try|return|throw|with|new|await|yield|typeof|delete)([ \t(]|$)',
  '^[ \t]*(' +
    [
      '(export[ \t]+)?(default[ \t]+)?(async[ \t]+)?function[ \t*].*',
      '(export[ \t]+)?(default[ \t]+)?(abstract[ \t]+)?class[ \t].*',
      '(export[ \t]+)?(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*(:.*)?=[ \t]*(async[ \t]+)?(\\(.*\\)[ \t]*(:[^=]*)?=>.*|\\(|[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=>.*|function[ \t(*].*)',
      '(export[ \t]+)?(declare[ \t]+)?(interface|enum|namespace|module)[ \t].*',
      '((public|private|protected|static|async|override|abstract|get|set)[ \t]+)+[A-Za-z_$#*][A-Za-z0-9_$]*[ \t]*(<.*>)?\\(.*',
      '[A-Za-z_$#][A-Za-z0-9_$]*[ \t]*(<.*>)?\\(.*\\)[ \t]*(:.*)?\\{[ \t]*',
      '(describe|it|test)(\\.[A-Za-z]+)*[ \t]*\\(.*',
    ].join('|') +
    ')$',
].join('\n');

let grepAttributesPath: string | undefined;

/**
 * An attributes file mapping extensions to GREP_FUNC_DRIVERS. Every other file gets `kcrline`, whose every line is a
 * function start, so -W adds nothing to -C there. A repo's own .gitattributes takes precedence over this file.
 * Written to a private temp dir that is removed on exit, and rewritten if the OS temp cleaner removed it: git
 * ignores a missing attributes file without an error.
 */
function grepAttributesFile(): string {
  if (grepAttributesPath && existsSync(grepAttributesPath)) return grepAttributesPath;
  const lines = ['* diff=kcrline'];
  for (const [driver, exts] of Object.entries(GREP_FUNC_DRIVERS))
    for (const ext of exts) lines.push(`*.${ext} diff=${driver}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'kcr-grep-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gitattributes');
  writeFileSync(file, lines.join('\n') + '\n', { flag: 'wx' });
  return (grepAttributesPath = file);
}

/** git config for -W: the attributes file and the two custom drivers. */
const grepFunctionConfig = (): string[] => [
  '-c',
  `core.attributesFile=${grepAttributesFile()}`,
  '-c',
  `diff.kcrjs.xfuncname=${KCRJS_FUNCNAME}`,
  '-c',
  'diff.kcrline.xfuncname=^',
];

/** Runs git grep; exit 1 (no match) is an empty result, and output past the buffer cap is truncated. */
function gitGrep(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'buffer',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
      },
      (err, stdout) => {
        if (!err) return resolve(stdout);
        const e = err as { code?: string | number };
        if (e.code === 1) return resolve(Buffer.alloc(0));
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(Buffer.from(stdout ?? ''));
        // Exit >=2 (typically 128) means git rejected the arguments, e.g. a malformed regex. The caller
        // retries such a query as a fixed string, so surface it as a distinct, recoverable failure.
        if (typeof e.code === 'number' && e.code >= 2)
          return reject(new ToolError('GREP_BAD_PATTERN', 'git grep rejected the pattern.'));
        reject(new ToolError('GIT_ERROR', 'git grep failed.'));
      },
    );
  });
}

/**
 * Regex (POSIX extended, `-E`) search over text files at HEAD, or the working tree with includeUncommitted. Each
 * match comes with GREP_CONTEXT_LINES lines either side and its enclosing function (-W), the function kept up to
 * GREP_FUNCTION_LINES lines either side. A literal string is a valid extended regex, so literal queries keep
 * matching; a pattern git rejects is retried as a fixed string. Lines in denylisted or malformed paths are dropped.
 * Returns `path:line: text` for a match and `path-line- text` for context, with `--` between non-adjacent blocks.
 * At most 20 matches, 200 chars per line and 32 KB in total.
 */
export async function grepRepo(
  top: string,
  headSha: string,
  query: string,
  includeUncommitted: boolean,
): Promise<string[]> {
  const run = async (regex: boolean, context: boolean) =>
    parseGrep(
      (await runGrep(top, headSha, query, includeUncommitted, regex, context)).toString('utf8'),
      headSha,
      includeUncommitted,
    );
  // With -z, git prints match and context lines alike, so a plain pass, run alongside, says which lines matched.
  const both = (regex: boolean) => Promise.all([run(regex, false), run(regex, true)]);
  let matched: GrepLine[];
  let lines: GrepLine[];
  try {
    [matched, lines] = await both(true);
  } catch (e) {
    // A malformed regex falls back to a literal search rather than failing the whole request.
    if (!(e instanceof ToolError) || e.code !== 'GREP_BAD_PATTERN') throw e;
    [matched, lines] = await both(false);
  }
  const hits = new Set(matched.map((l) => `${l.file}\0${l.lineNo}`));
  // Only the matches that can be returned: lines that lead into a match past the cap are not context.
  lines = nearMatches(lines, matched.slice(0, GREP_MAX_MATCHES));
  const out: string[] = [];
  let bytes = 0;
  let matches = 0;
  let last: GrepLine | null = null;
  // True while the current block has had a match: the lines after it are its trailing context.
  let inMatchBlock = false;
  // Output length through the last match and its trailing context; lines past it lead into a match a cap cut off.
  let keep = 0;
  for (const l of lines) {
    const isMatch = hits.has(`${l.file}\0${l.lineNo}`);
    const adjacent = last !== null && last.file === l.file && last.lineNo + 1 === l.lineNo;
    const inTail: boolean = !isMatch && adjacent && inMatchBlock;
    if (matches >= GREP_MAX_MATCHES && (isMatch || !inTail)) break;
    const chars = [...l.text];
    const text = chars.length > GREP_LINE_CHARS ? chars.slice(0, GREP_LINE_CHARS - 1).join('') + '…' : chars.join('');
    const mark = isMatch ? ':' : '-';
    const block = [...(last !== null && !adjacent ? ['--'] : []), `${l.file}${mark}${l.lineNo}${mark} ${text}`];
    const size = block.reduce((n, x) => n + Buffer.byteLength(x, 'utf8') + 1, 0);
    if (bytes + size > GREP_MAX_BYTES) break;
    bytes += size;
    out.push(...block);
    last = l;
    if (isMatch) matches++;
    inMatchBlock = isMatch || inTail;
    if (inMatchBlock) keep = out.length;
  }
  return out.slice(0, keep);
}

/**
 * Drops lines more than GREP_FUNCTION_LINES from every match in their file, so the lead-in to a match deep in a long
 * function cannot use up the byte budget before the match itself. Both lists are in git's order: by file, then line.
 */
function nearMatches(lines: GrepLine[], matched: GrepLine[]): GrepLine[] {
  const byFile = new Map<string, number[]>();
  for (const m of matched) {
    const nums = byFile.get(m.file);
    if (nums) nums.push(m.lineNo);
    else byFile.set(m.file, [m.lineNo]);
  }
  const next = new Map<string, number>();
  return lines.filter((l) => {
    const nums = byFile.get(l.file);
    if (!nums) return false;
    let i = next.get(l.file) ?? 0;
    while (i < nums.length && nums[i] < l.lineNo - GREP_FUNCTION_LINES) i++;
    next.set(l.file, i);
    return i < nums.length && nums[i] <= l.lineNo + GREP_FUNCTION_LINES;
  });
}

/** One git grep pass: `-E` for extended regex, otherwise `-F` for a fixed string; optionally with context. */
function runGrep(
  top: string,
  headSha: string,
  query: string,
  includeUncommitted: boolean,
  regex: boolean,
  context: boolean,
): Promise<Buffer> {
  const args = [...(context ? grepFunctionConfig() : []), 'grep', '-z', '-n', '-I', regex ? '-E' : '-F', '--no-color'];
  if (context) args.push('-W', '-C', String(GREP_CONTEXT_LINES));
  args.push('-e', query);
  if (!includeUncommitted) args.push(headSha);
  args.push('--');
  return gitGrep(top, args);
}

interface GrepLine {
  file: string;
  lineNo: number;
  text: string;
}

/** Parses `git grep -z -n` output into path-filtered lines; group separators are skipped. */
function parseGrep(out: string, headSha: string, includeUncommitted: boolean): GrepLine[] {
  const prefix = includeUncommitted ? '' : `${headSha}:`;
  const lines: GrepLine[] = [];
  for (const record of out.split('\n')) {
    const a = record.indexOf('\0');
    const b = a < 0 ? -1 : record.indexOf('\0', a + 1);
    if (b < 0) continue;
    let file = record.slice(0, a);
    if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
    const lineNo = record.slice(a + 1, b);
    if (!/^[1-9][0-9]*$/.test(lineNo) || !isWellFormedPath(file) || isDeniedPath(file)) continue;
    lines.push({ file, lineNo: Number(lineNo), text: record.slice(b + 1) });
  }
  return lines;
}

/** Record separator between commits and field separator between subject and body in `git log --format`. */
const COMMIT_REC_SEP = '\x1e';
const COMMIT_FIELD_SEP = '\x00';

/**
 * Commit subjects and bodies for merge-base..HEAD, newest first. Author, email and
 * timestamp are never requested. Capped at `commitCount` commits and `commitBytes` total utf-8 bytes:
 * drop the oldest commits past the count, then truncate bodies (oldest first) to fit the byte budget.
 * includeUncommitted does not add commits (uncommitted changes are not commits), so the range is the
 * same merge-base..HEAD either way.
 */
export async function collectCommits(
  top: string,
  mergeBase: string,
  headSha: string,
): Promise<Array<{ subject: string; body?: string }>> {
  // git's %x00/%x1e placeholders emit literal NUL/RS bytes in the output; passing raw NUL inside the
  // --format argument would truncate the argument at the NUL, so the placeholders are required.
  const format = '%x00%s%x00%b%x1e';
  let out: string;
  try {
    out = await gitText(top, ['log', `--format=${format}`, '--no-color', `${mergeBase}..${headSha}`], 'commits.bytes');
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('GIT_ERROR', 'Listing commits failed.');
  }
  const commits: Array<{ subject: string; body?: string }> = [];
  for (const record of out.split(COMMIT_REC_SEP)) {
    if (commits.length >= LIMITS.commitCount) break;
    // Each record is `<FIELD>subject<FIELD>body`; leading field sep is the format prefix.
    const parts = record.split(COMMIT_FIELD_SEP);
    if (parts.length < 3) continue; // not a full record (e.g. the trailing empty chunk)
    const subject = parts[1];
    const body = parts.slice(2).join(COMMIT_FIELD_SEP).replace(/\n+$/, '');
    if (subject === '' && body === '') continue;
    commits.push(body === '' ? { subject } : { subject, body });
  }
  return capCommitBytes(commits);
}

/** Drops oldest commits, then truncates oldest bodies, until the summed utf-8 bytes fit commitBytes. */
function capCommitBytes(commits: Array<{ subject: string; body?: string }>): Array<{ subject: string; body?: string }> {
  const bytesOf = (cs: ReadonlyArray<{ subject: string; body?: string }>): number =>
    cs.reduce((n, c) => n + utf8Bytes(c.subject) + utf8Bytes(c.body ?? ''), 0);
  // Work on a copy, newest first (as supplied). Oldest is the last element.
  const kept = [...commits];
  // First, truncate bodies starting from the oldest, dropping whole bodies if needed.
  for (let i = kept.length - 1; i >= 0 && bytesOf(kept) > LIMITS.commitBytes; i--) {
    const c = kept[i];
    if (c.body === undefined) continue;
    const over = bytesOf(kept) - LIMITS.commitBytes;
    const bodyBytes = utf8Bytes(c.body);
    if (bodyBytes <= over) {
      kept[i] = { subject: c.subject };
    } else {
      // Truncate by code points until the body fits; small loop, bounded by body length.
      const chars = [...c.body];
      let truncated = c.body;
      while (utf8Bytes(truncated) > bodyBytes - over && chars.length > 0) {
        chars.pop();
        truncated = chars.join('');
      }
      kept[i] = truncated === '' ? { subject: c.subject } : { subject: c.subject, body: truncated };
    }
  }
  // If still over (subjects alone exceed the budget), drop oldest commits.
  while (kept.length > 0 && bytesOf(kept) > LIMITS.commitBytes) kept.pop();
  return kept;
}

export async function collectRepo(input: CollectInput): Promise<CollectedRepo> {
  validateRef(input.base);
  // Steps 1 and 3: toplevel and HEAD.
  const { top, headSha } = await openRepo(input.repoPath);

  // Steps 2 and 4.
  let baseSha: string;
  try {
    baseSha = (await gitText(top, ['rev-parse', '--verify', '--end-of-options', `${input.base}^{commit}`])).trim();
  } catch {
    throw new ToolError('BASE_NOT_FOUND', 'The base ref was not found in the repository.');
  }
  let headRef = 'HEAD';
  try {
    const abbrev = (await gitText(top, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (abbrev.length > 0 && abbrev.length <= 200) headRef = abbrev;
  } catch {
    // Detached or unusual HEAD: keep "HEAD".
  }
  let mergeBase: string;
  try {
    mergeBase = (await gitText(top, ['merge-base', baseSha, headSha])).trim();
  } catch {
    throw new ToolError('NO_MERGE_BASE', 'The base and HEAD have no common ancestor.');
  }
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new ToolError('NO_MERGE_BASE', 'Could not compute the merge-base.');

  // Step 5: diff from the merge-base, with the widest context in DIFF_CONTEXT_TIERS that fits the size limit.
  const diffWith = async (context: number): Promise<string> => {
    const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `-U${context}`, '-M', mergeBase];
    if (!input.includeUncommitted) diffArgs.push(headSha);
    diffArgs.push('--');
    try {
      return await gitText(top, diffArgs, 'diff.bytes');
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('GIT_ERROR', 'git diff failed.');
    }
  };
  let diff = '';
  for (const [i, context] of DIFF_CONTEXT_TIERS.entries()) {
    // The narrowest diff is used whatever its size; the payload limit check reports one that is still too large.
    const narrowest = i === DIFF_CONTEXT_TIERS.length - 1;
    try {
      diff = await diffWith(context);
      if (narrowest || utf8Bytes(diff) <= LIMITS.diffBytes) break;
    } catch (e) {
      if (narrowest || !(e instanceof ToolError) || e.code !== 'LIMIT_EXCEEDED') throw e;
    }
  }
  if (diff.trim() === '') throw new ToolError('EMPTY_DIFF', 'There are no changes between the merge-base and HEAD.');

  // Step 6: REVIEW.md from the merge-base, so a PR can't rewrite its own review guidance.
  const reviewMd = await showRuleFile(top, mergeBase, 'REVIEW.md');

  // Commit messages for merge-base..HEAD.
  const commits = await collectCommits(top, mergeBase, headSha);

  // Step 7: context files.
  const context: Array<{ path: string; content: string }> = [];
  for (const rel of input.contextFiles) {
    const posix = resolveContextPath(top, rel);
    const buf = await readRepoFile(top, headSha, posix, input.includeUncommitted);
    if (buf === null) {
      throw new ToolError(
        'CONTEXT_NOT_FOUND',
        'A context file is not committed at HEAD (commit it or use includeUncommitted).',
      );
    }
    const text = decodeText(buf);
    if (text === null) throw new ToolError('CONTEXT_NOT_TEXT', 'A context file is not UTF-8 text.');
    context.push({ path: posix, content: text });
  }

  return {
    toplevel: top,
    repoName: path.basename(top),
    baseSha,
    headSha,
    headRef,
    mergeBase,
    diff,
    rules: reviewMd !== undefined ? { reviewMd } : {},
    context,
    commits,
  };
}
