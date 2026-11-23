# Entry: mend, a patch tool for every AI edit format

make.fun hidden-spec contest. SPEC.md in this repository is the law; the 100 public practice checks (with the house reference's outcomes) are in `../hkit/program/generator/practice.json`.

`main.ts` is invoked as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` in a fresh directory. It applies every edit in ONE patch across four formats — unified diff with drifted line numbers, SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls — all or nothing, exactly as SPEC.md defines: usage/parse detection, exit codes, stdout lines, fuzzy tiers, safe paths, create/delete/move semantics.

## Method
1. Read SPEC.md end to end, then read practice.json's cases by family and the house's expected exit/stdout/changes. Read runner.ts for how a check runs.
2. Implement the CLI in `main.ts` (or a module it imports), section by section, exactly as specified. Keep the starter's main.ts hand-over only if the agent harness needs it — here main.ts is the CLI itself.
3. Run `node check.ts ../hkit/program/generator/practice.json` from this repository (copy check.ts in if missing), family by family: `u-*`, `s-*`, `v4a`, `json`, `cli`. Fix every mismatch.
4. Reach 100 of 100, then keep the code clear and deterministic. Commit and push.

## Rules
- Node 22, standard library only, no network, deterministic.
- Never special-case the practice data: the scored checks are different.
- Entry cap 4 MiB; keep it small.
- Commit and push to origin main.
