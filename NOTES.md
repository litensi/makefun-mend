mend reads a single patch and applies every edit it contains to the working tree.
Unified diff splits the patch into file sections (`diff --git` or `---`/`+++`) whose `@@ -A +C @@` hunks carry context, `-` and `+` lines; wrong line numbers are tolerated.
SEARCH/REPLACE names a path, then a `<<<<<<< SEARCH` block of old lines, `=======`, new lines and `>>>>>>> REPLACE`.
V4A is a `*** Begin Patch` … `*** End Patch` document of Add, Delete and Update File sections with ` `, `-` and `+` body lines and `@@` anchors.
JSON is an array or JSON Lines of edit objects using `create`, `str_replace` (exact text) and `insert` commands.
Old lines are matched in tiers: tier 0 compares exactly, tier 1 ignores trailing spaces and tabs, tier 2 also ignores leading ones.
The first tier that yields an occurrence is used, and `--strict` allows only tier 0.
No occurrence at any tier is `no-match`; several occurrences where the format gives no chooser is `ambiguous`.
All-or-nothing: a failed edit changes nothing, later edits still run, and every failure is reported.
When any edit fails nothing is written and the exit code is 1, with one `error:` line per failure and a final `failed:` count.
Exit 0 means all edits succeeded and the tree is written (or, under `--check`, left untouched).
Exit 2 writes nothing and prints one line: a usage error, unreadable patch, undetected format, or parse error.
