# Contributing

Issues and pull requests are welcome. This page covers getting the project
running, the test suite, and how to exercise the tools against a real Zotero.

## The workflow, start to finish

1. **Open an issue first**, unless the change is a typo or a one-line fix. It is
   cheaper to agree on an approach in an issue than to review a branch built on
   the wrong one. Search the existing issues before filing; if one already
   covers your case, comment there instead. GitHub will offer three templates —
   bug report, feature request, and a **platform report** for telling us this
   ran (or did not) somewhere the README has not verified.
2. **Branch off `main`.** Never commit to `main` directly.
3. **Commit in logical groups**, following the message format below.
4. **Run the checks** before opening the pull request.
5. **Open the pull request.** A template is filled in for you; reference the
   issue with `Closes #123` so it closes when the branch merges.

### Branch names

`<type>/<short-description>`, using the same types as the commit format:

```
feat/group-library-attachments
fix/windows-file-url
docs/clarify-linked-vs-imported
ci/add-node-24
```

### Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/).
The subject line is `type(scope): summary`, where the scope is optional and
names the part of the codebase affected:

```
fix(attachments): refuse linked files in group libraries up front
feat(pagination): report hasMore alongside the paging cursor
docs: move contributor material out of the README
ci: run the suite on Linux, macOS and Windows
```

Types in use here: `feat`, `fix`, `docs`, `ci`, `chore`. Scopes are drawn from
the source layout — `client`, `auth`, `attachments`, `collections`, `items`,
`pagination`.

Keep the subject under about 72 characters, in the imperative mood ("refuse",
not "refused" or "refuses"). Then leave a blank line and explain **why** the
change was needed in the body. A reader six months from now can see what the
diff did; what they cannot recover is the reasoning, so that is what the body is
for. Look at `git log` for the tone.

### Before you open the pull request

Run these and confirm they pass:

```bash
npm run typecheck
npm run build
npm test
```

If your change touches how the server talks to Zotero, also run
`node scripts/coverage.mjs` against a real library and say so in the pull
request — CI cannot do that, because no runner has Zotero installed.

## Setup

```bash
git clone https://github.com/dvdsosa/zotero-native-mcp.git
cd zotero-native-mcp
npm install
npm run build
```

`npm run` lists every script; these are the ones worth knowing:

| Command | Why you would run it |
|---|---|
| `npm run watch` | Recompile on save while working. |
| `npm test` | The full suite. This is the bar for a pull request. |
| `npm run inspect` | Open the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) against a fresh build — a browser UI that lists the tools, shows their schemas, and lets you call one by hand and read the raw response. The fastest way to see what a tool actually returns without wiring up an assistant. |

Point your own MCP client at the build to use it while developing:

```bash
claude mcp add zotero-dev -- node /absolute/path/to/build/index.js
```

## The bar for a pull request

CI runs `npm run typecheck`, `npm run build` and `npm test` on **Linux, macOS
and Windows across Node 20, 22 and 24** — nine jobs, with `fail-fast` off so one
broken combination does not hide the others. All of it must pass.

Two habits matter more than the checks:

- **Errors are written for an agent.** Every failure should say what went wrong
  *and* what the caller should do next. Compare the hints in `src/errors.ts`
  before adding a new one.
- **Tool descriptions are the interface.** A model only ever sees the name,
  description and schema. A behaviour that is not described does not exist.

## Tests

`npm test` runs 67 tests on `node:test`. There is no test framework to install.

| Suite | Covers | Needs Zotero |
|---|---|:---:|
| `test/format.test.mjs` | Response shaping and pagination arithmetic | no |
| `test/config.test.mjs` | Environment parsing and defaults | no |
| `test/keystore.test.mjs` | Key persistence, `0600` permissions, corrupt stores | no |
| `test/client.test.mjs` | The wire protocol, against a mock Zotero | no |
| `test/validation.test.mjs` | Argument rejection, over stdio | no |
| `test/integration.test.mjs` | The real server over stdio | **yes** |

`test/helpers/mock-zotero.mjs` stands in for Zotero's local API: it reproduces
the `Zotero-Server-ID` handshake, local API keys including the single-use kind,
and the status codes Zotero actually returns. That is what lets the protocol be
tested on a CI runner with no Zotero installed.

The integration suite skips itself when nothing answers on
`127.0.0.1:23119`, so CI stays green without special handling.

## Exercising a real library

These scripts talk to a running Zotero and are not part of `npm test`. They
create their own objects and delete them again; nothing pre-existing is touched.

```bash
node scripts/smoke.mjs read        # read tools, end to end
node scripts/smoke.mjs write       # the write path
node scripts/smoke.mjs group       # the same cycle in a group library
node scripts/coverage.mjs          # every tool, with a coverage report
node scripts/coverage.mjs --group
```

`coverage.mjs` is the thorough one. It calls all 24 tools, reports which ran,
and distinguishes a real failure from a tool it had no data to exercise — a
library with no saved searches cannot test `run_saved_search`, and that is not a
defect. Cleanup runs in a `finally` block, so a run that dies partway still
removes what it created.

A write raises Zotero's consent dialog. Choose **"Always Allow"**: a plain
"Allow" issues a single-use key, and every subsequent write then needs its own
dialog.

## Evaluating tool descriptions

[`../evaluation/evaluation.xml`](../evaluation/evaluation.xml) holds 12 question
and answer pairs. Running them checks something the test suite cannot: whether a
model, given only the tool descriptions, can reach the right answer. It is a
test of the writing, not the code.

Use the harness from Anthropic's `mcp-builder` skill against any
Anthropic-compatible endpoint:

```bash
ANTHROPIC_BASE_URL=https://openrouter.ai/api \
ANTHROPIC_API_KEY=<key> \
python evaluation.py -t stdio -c node -a build/index.js \
  -m anthropic/claude-haiku-4.5 evaluation/evaluation.xml
```

See [`../.env.example`](../.env.example) for the variables it reads. The answers
in that file are tied to one particular library, so replace them with facts from
your own before running it.

---

<p align="center"><a href="../README.md">⬅ <b>Back to the main README</b></a></p>
