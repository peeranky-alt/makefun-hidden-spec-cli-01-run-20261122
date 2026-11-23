# mend

One patch tool for every AI edit format.

`mend` reads an edit written by an AI model — a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool
calls as JSON — finds the lines each edit names even when the model drifted
their whitespace or indentation, and changes every file or none (atomic).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit names old lines that are replaced by new lines. They are found in the
file at the first of three tiers at which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed.

At tier 2, new lines are re-indented to the file's indentation. Context lines
are always written as the file's own matched lines.

## Output

- Exit 0: one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a
  move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. When any edit fails, no file is written.
- Exit 2: a single `error:` line (`usage`, `no-patch`, `format`, or
  `parse <N>`).

## Formats

- **Unified diff**: sections (`diff --git`, `---`/`+++`, rename, new/deleted
  file), hunks applied in order, each taking the occurrence nearest its (often
  wrong) line number. Creations, deletions and moves included.
- **SEARCH/REPLACE**: blocks of old lines between `<<<<<<< SEARCH` and
  `=======`, new lines up to `>>>>>>> REPLACE`; the path is the nearest
  non-blank, non-fence line above the block.
- **V4A**: `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections, optional
  `*** Move to:`, `@@` anchors and `*** End of File` chunks, applied with a
  cursor that moves through the file.
- **JSON**: one JSON array of edit objects, or JSON Lines — `create`,
  `str_replace` and `insert` commands.

See `SPEC.md` in the competition kit for the whole contract; this tool
implements it. Node 22 and its standard library only; no dependencies.
