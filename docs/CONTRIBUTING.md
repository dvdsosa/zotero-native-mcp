# Contributing

Never contributed to an open-source project before? That is fine. This page is
written to be followed in order, from cloning the repository to opening a pull
request.

## 1. Get it running

```bash
git clone https://github.com/dvdsosa/zotero-native-mcp.git
cd zotero-native-mcp
npm install
npm run build
```

Then point your own MCP client at your build, so you can use it while you work
on it:

```bash
claude mcp add --scope user zotero-dev -- node /absolute/path/to/build/index.js
```

While editing, `npm run watch` recompiles on save.

The other command worth knowing is **`npm run inspect`**. It opens the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector), a browser UI
that lists every tool, shows its schema, and lets you call one by hand and read
the raw response. It is the quickest way to see what a tool really returns
without going through an assistant.

## 2. Find the file you need

| Where | What lives there |
|---|---|
| `src/tools/` | The tools themselves, one file per area, `items`, `collections`, `attachments`, `discovery`, `system`. Most changes belong here. |
| `src/client.ts` | Everything about talking to Zotero: the server-ID handshake, API keys, retries, turning HTTP statuses into useful errors. |
| `src/errors.ts` | The error types and their remediation text. |
| `src/format.ts` | Trimming Zotero's responses down before they reach the model. |
| `test/` | The test suite. Every file here is discovered and run by `npm test`. |
| `test-utils/` | Helpers the tests import. Deliberately outside `test/`, so Node's test discovery does not treat them as suites. |
| `docs/` | This documentation. |

## 3. Two conventions specific to this project

Everything else is ordinary TypeScript, but these two are easy to miss and they
matter more here than the linting:

- **Errors are written for an AI agent, not a log file.** Every failure should
  say what went wrong *and* what the caller should do next. Read a few hints in
  `src/errors.ts` before writing a new one.
- **A tool's description is its entire interface.** A model never reads the
  code, only the tool's name, description and schema. Behaviour you do not
  describe effectively does not exist.

## 4. Check your work

Run these three. They are exactly what CI will run:

```bash
npm run typecheck
npm run build
npm test
```

`npm test` runs 73 tests using `node:test`, which ships with Node. There is no
test framework to install. Five of the six suites need no Zotero at all, because
`test-utils/mock-zotero.mjs` imitates Zotero's local API well enough to
exercise the real protocol:

| Suite | Covers | Needs Zotero |
|---|---|:---:|
| `test/format.test.mjs` | Response shaping and pagination | no |
| `test/config.test.mjs` | Environment parsing and defaults | no |
| `test/keystore.test.mjs` | Key storage and file permissions | no |
| `test/client.test.mjs` | The protocol, against the mock Zotero | no |
| `test/validation.test.mjs` | Rejecting bad arguments | no |
| `test/integration.test.mjs` | The real server, over stdio | **yes** |

The integration suite skips itself when nothing answers on `127.0.0.1:23119`,
so it never fails just because Zotero is closed.

### If your change affects how the server talks to Zotero

CI cannot catch those problems: no GitHub runner has Zotero installed. Run this
against your own library and say so in the pull request:

```bash
node scripts/coverage.mjs
```

It calls all 28 tools and reports which ones ran. It creates its own collection,
item and attachments and deletes them in a `finally` block, so nothing of yours
is touched even if the run dies partway. `scripts/smoke.mjs` covers narrower
slices, see `read`, `write` and `group`.

> [!NOTE]
> The first write raises Zotero's consent dialog. Choose **"Always Allow"**. A
> plain "Allow" grants a key good for one write only, so every write after it
> pops the dialog again.

## 5. Send it

1. **Open an issue first**, unless it is a typo or a one-liner. Agreeing on the
   approach in an issue is cheaper than rewriting a finished branch. GitHub
   offers three templates: bug report, feature request, and a **platform
   report** for telling us it ran (or did not) somewhere the README has not
   verified.
2. **Make a branch.** Never commit to `main`.
   ```text
   feat/group-library-attachments
   fix/windows-file-url
   docs/clarify-linked-vs-imported
   ```
3. **Commit**, following the format below.
4. **Open the pull request.** A template fills itself in. Write `Closes #123` in
   it so the issue closes when your branch merges.

### Commit messages

This repository follows [Conventional Commits](https://www.conventionalcommits.org/):
a `type`, an optional `(scope)` naming the part of the code affected, then a
summary.

```text
fix(attachments): refuse linked files in group libraries up front
feat(pagination): report hasMore alongside the paging cursor
docs: move contributor material out of the README
ci: run the suite on Linux, macOS and Windows
```

Types used here are `feat`, `fix`, `docs`, `ci` and `chore`. Scopes come from
the source layout: `client`, `auth`, `attachments`, `collections`, `items`.

Keep the summary short and phrase it as an instruction, "refuse", not "refused"
or "refuses". Then leave a blank line and use the body to explain **why** the
change was needed. Anyone can read the diff to see what changed; the reasoning
is the part that is lost otherwise. `git log` shows the tone.

### What happens next

Opening the pull request starts CI: nine jobs covering **Linux, macOS and
Windows across Node 22, 24 and 26**. All must pass. They run on GitHub's
machines, not yours, and if your change breaks only one combination you will see
exactly which.

---

## Appendix, evaluating tool descriptions

*Maintainers only. This needs a paid API key and a tool that is not part of this
repository; nothing in a normal contribution requires it.*

[`../evaluation/evaluation.xml`](../evaluation/evaluation.xml) holds 12 question
and answer pairs about a real Zotero library. Running them measures something no
unit test can: whether a model, given nothing but the tool descriptions, can
reach the right answer. It tests the writing rather than the code.

The runner is not in this repository: it is `evaluation.py`, shipped with
Anthropic's `mcp-builder` skill, which you install separately. Invoke it from a
checkout of this repository so the relative paths resolve, with
`ANTHROPIC_BASE_URL` pointed at any endpoint that speaks the Anthropic Messages
API, [`../.env.example`](../.env.example) lists the variables. The answers in
the XML describe one particular library, so replace them with facts from yours
before trusting the score.

---

<p align="center"><a href="../README.md">⬅ <b>Back to the main README</b></a></p>
