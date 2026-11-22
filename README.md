# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Minergold121/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Minergold121/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one command-line patch tool for every edit format AI models write:
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches, and text-editor tool calls as JSON. It reads a patch to one written
specification, finds the lines an edit names even when their whitespace or
indentation drifted, and changes every file or none of them.

Built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-`/absent for standard input. `--format` picks
one of `auto` (the default, detected), `unified`, `search-replace`, `v4a` or
`json`. `--check` reports what would change without writing anything.
`--strict` matches lines exactly. The working directory is the root of the
tree the patch edits. Node 22 and its standard library only; nothing is
installed before the program runs.

## Files

- `main.ts` — the CLI, implementing `SPEC.md` (see the starter kit).
- `runner.ts` — the kit's trial runner, kept as shipped; it runs `main.ts`
  on each check of a trial.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hn1mwamt&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
