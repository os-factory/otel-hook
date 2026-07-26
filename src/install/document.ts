import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import * as path from "node:path";

/**
 * Reading and writing a *third party's* configuration document.
 *
 * Two properties matter more here than anywhere else in this package, because
 * the file belongs to the developer and not to us:
 *
 * 1. **Never lose a byte we did not mean to change.** The file's indentation,
 *    line endings, and trailing newline are detected on read and reproduced on
 *    write, so a registration shows up in `git diff` as the lines it added and
 *    nothing else. A document that cannot be parsed is reported, never
 *    overwritten.
 * 2. **Never leave a half-written file.** Every write lands through a temp file
 *    in the same directory plus `rename`, which is atomic on POSIX and, via
 *    libuv's `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, on Windows. A process
 *    killed mid-write leaves an orphaned temp file, never a truncated
 *    `settings.json`.
 */

export type JsonDocumentFormat = {
  /** Indent string detected from the file, e.g. `"  "` or `"\t"`. */
  readonly indent: string;
  readonly eol: "\n" | "\r\n";
  readonly trailingNewline: boolean;
};

/**
 * What a brand-new document looks like. `"\n"` rather than the platform EOL: a
 * config file this tool creates should read the same on every machine that
 * shares the repository, and every JSON parser accepts it.
 */
export const DEFAULT_DOCUMENT_FORMAT: JsonDocumentFormat = Object.freeze({
  indent: "  ",
  eol: "\n" as const,
  trailingNewline: true,
});

export type ReadDocumentResult =
  | { readonly status: "absent"; readonly format: JsonDocumentFormat }
  | {
      readonly status: "ok";
      readonly value: unknown;
      readonly raw: string;
      readonly format: JsonDocumentFormat;
    }
  | {
      readonly status: "unparseable";
      readonly raw: string;
      /** Non-sensitive: the parser message, never the file's contents. */
      readonly detail: string;
      readonly format: JsonDocumentFormat;
    }
  | { readonly status: "unreadable"; readonly detail: string };

const isErrnoException = (thrown: unknown, ...codes: readonly string[]): boolean =>
  thrown instanceof Error && codes.includes((thrown as NodeJS.ErrnoException).code ?? "");

/**
 * Infer the indent, line ending, and trailing newline actually used.
 *
 * The indent is read from the first indented line rather than from the deepest
 * one, because that is the level `JSON.stringify` will reproduce first and the
 * only one it can reproduce at all — it has a single indent setting.
 */
export const detectDocumentFormat = (raw: string): JsonDocumentFormat => {
  const eol = /\r\n/.test(raw) ? ("\r\n" as const) : ("\n" as const);
  const indentMatch = /(?:\r?\n)([ \t]+)\S/.exec(raw);
  return {
    indent: indentMatch?.[1] ?? DEFAULT_DOCUMENT_FORMAT.indent,
    eol,
    trailingNewline: raw.length === 0 || /\r?\n$/.test(raw),
  };
};

export const renderJsonDocument = (value: unknown, format: JsonDocumentFormat): string => {
  const body = JSON.stringify(value, null, format.indent);
  const withEol = format.eol === "\n" ? body : body.split("\n").join(format.eol);
  return format.trailingNewline ? `${withEol}${format.eol}` : withEol;
};

export const readJsonDocument = async (filePath: string): Promise<ReadDocumentResult> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (thrown) {
    if (isErrnoException(thrown, "ENOENT")) {
      return { status: "absent", format: DEFAULT_DOCUMENT_FORMAT };
    }
    return {
      status: "unreadable",
      detail: thrown instanceof Error ? thrown.name : typeof thrown,
    };
  }

  const format = detectDocumentFormat(raw);
  if (raw.trim().length === 0) {
    // An empty file is a legitimate "nothing configured yet" state that
    // `JSON.parse` rejects. Treating it as absent lets setup populate it.
    return { status: "absent", format };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as unknown, raw, format };
  } catch (thrown) {
    return {
      status: "unparseable",
      raw,
      detail: thrown instanceof Error ? thrown.message.slice(0, 200) : "not well-formed JSON",
      format,
    };
  }
};

/**
 * On Windows a rename can transiently fail while an indexer or antivirus holds
 * the destination open. A short bounded retry turns a spurious failure into a
 * successful write; a real permission problem still surfaces after the last try.
 */
const RENAME_RETRY_DELAYS_MILLIS: readonly number[] = [10, 25, 50, 100];

/** Not `unref`'d: see the note in `file-lock.ts` — a waiter must keep the process alive. */
const delay = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });

const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (thrown) {
      const retryable = isErrnoException(thrown, "EPERM", "EACCES", "EBUSY");
      const remaining = RENAME_RETRY_DELAYS_MILLIS[attempt];
      if (!retryable || remaining === undefined) {
        throw thrown;
      }
      await delay(remaining);
    }
  }
};

/**
 * Mode for a configuration document this tool creates: owner read/write only.
 *
 * Deliberately not left to the process umask. A hook command line can carry an
 * `--endpoint` with a token in it, and these files sit in a home directory that
 * is frequently group- or world-readable; a default umask of 022 would publish
 * every registration this tool writes to any local account. An operator who
 * wants it wider can widen it, and a *replacement* never narrows what was
 * already there — see {@link writeDocumentAtomically}.
 */
export const NEW_DOCUMENT_MODE = 0o600;

/** Owner-only mode for the temp file, so the window before the rename is not wider than the result. */
const TEMPORARY_DOCUMENT_MODE = 0o600;

/**
 * Write `contents` to `filePath` atomically, creating parent directories.
 *
 * The temp file is created in the destination directory so the rename stays
 * within one filesystem, and is fsynced before the rename so a crash cannot
 * leave the renamed file pointing at unflushed data.
 *
 * A rename replaces the destination *inode*, so the mode travels with the temp
 * file rather than with the path — which means an atomic replace silently
 * re-permissions the file unless the original mode is carried across. An
 * existing document keeps exactly the mode it had (a developer who chmodded
 * their `settings.json` to 0600, or to 0644, keeps that decision); a file this
 * tool creates gets {@link NEW_DOCUMENT_MODE} rather than whatever the umask
 * would have allowed. The temp file is owner-only for its whole life, so the
 * contents are never briefly readable by anyone who could not read the result.
 */
export const writeDocumentAtomically = async (
  filePath: string,
  contents: string,
): Promise<void> => {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  // Read before writing: after the rename the original inode is gone.
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(filePath)).mode & 0o7777;
  } catch (thrown) {
    if (!isErrnoException(thrown, "ENOENT")) {
      throw thrown;
    }
  }
  const targetMode = existingMode ?? NEW_DOCUMENT_MODE;

  try {
    const handle = await open(temporary, "wx", TEMPORARY_DOCUMENT_MODE);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      // Through the open handle, so the mode lands on the inode being renamed
      // even if something replaced the temp path underneath us.
      await handle.chmod(targetMode);
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, filePath);
  } catch (thrown) {
    await unlink(temporary).catch(() => undefined);
    throw thrown;
  }
};

/**
 * Narrow an existing document to owner-only, reporting the mode it had.
 *
 * Exported for `diagnose`, which can then say that a registration it did not
 * create is world-readable without changing it behind the operator's back.
 */
export const documentMode = async (filePath: string): Promise<number | undefined> => {
  try {
    return (await stat(filePath)).mode & 0o7777;
  } catch {
    return undefined;
  }
};

/** Set a document's mode, ignoring a platform that does not implement it. */
export const setDocumentMode = async (filePath: string, mode: number): Promise<void> => {
  await chmod(filePath, mode).catch(() => undefined);
};
