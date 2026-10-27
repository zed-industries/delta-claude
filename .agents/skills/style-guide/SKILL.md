---
name: style-guide
description: Conventions for the TypeScript in hooks/ of the Delta Claude Code plugin — what Claude Code's loader and Anthropic's plugin directory accept, where code and state go, typing untrusted input, errors, tests and formatting. Use when writing, editing, reviewing or refactoring code under hooks/.
---

# Delta plugin conventions

Where these rules and the surrounding code say nothing, choose the simplest thing that works: a little repetition
is better than an abstraction with one caller.

## Loading rules

Claude Code reads `hooks/register.tsx` and every file it imports before loading the plugin, and refuses code it
cannot follow. Anthropic's plugin directory is stricter: it lists the plugin's capabilities from the engine calls in
`register.tsx` alone, and refuses `$` handed to a function in another file, even though Claude Code accepts that.
`claude plugin validate` applies none of the directory's rules; only the developer portal's Validate does. The
engine's API is declared in `.claude-plugin/types/claude-code/index.d.ts`, which Claude Code writes when it loads
this folder.

- Only `register.tsx` names `$`. A hook that needs the engine beyond a direct call binds `const host = hostOf($)` as
  its first statement and passes `host` on. Features take `host: Host` (`core/host.ts`), never `$`. This follows
  Anthropic's own `code-modernization` plugin.
- An engine call a feature needs is a member of `Host` and one line in `hostOf`: a closure making a single literal
  call, `read: (path) => $.fs.read(path)`. An overloaded method gets one member per form Delta uses
  (`session.apiMessages`), and an environment variable one member per name (`env.os`), so every call stays literal.
  Bind a `Host` per hook call and keep none in a module variable: `$` carries the calling hook's context.
- In `register.tsx`, `$` goes only to `hostOf` and `logHookFailure`, which are top-level function declarations
  there. Write each call literally: `$.noun.method(...)`, `$.env.get('LITERAL')`, and `$.state` references with a
  literal `plugin` and `key`. Don't give anything else the name of `$`, `on`, or a hook's third parameter: the
  directory reads those names as the engine's throughout the file.
- Import types with `type` (`import type { Host }`, or `type Host` in a mixed import). Each file is compiled alone,
  so an unmarked type import fails at load with "Export named … not found".
- Import only the plugin's own files: no `import()`, Node or DOM APIs, or npm packages.

## Where code goes

- `register.tsx` holds the `on(...)` registrations, each with its `.catch`. A handler longer than a few lines is a
  function in its feature's module, typed `e: HookEvent<'tool.call'>, next: HookNext<'tool.call'>`. An event a
  subagent's loop also raises routes on `e.agentId` to `subagents.ts`.
- Each feature has a folder under `hooks/` (`watch/`, `recording/`, `sharing/`, …) holding its modules and their
  unit tests; `core/` holds what every feature uses, and `testing/` the test fake. New code goes in the module for
  its feature; each module's header says what it holds (`head -6 hooks/*/*.ts*`). Logic without a `Host` sits in a
  module of its own, which tests call directly.
- Pass `host` to helpers. The narrower hosts `SetupEnv`, `Interaction`, `AuthenticationHost` and `UpdateHost` are
  built from it so tests can substitute them; add no others.
- Export only what another module or a test uses. A module variable others read is an `export let`, with no getter.
- Run a Delta command through a `delta-cli.ts` function (sign-in and updates go through their hosts). It labels the
  command as Claude Code's for Delta's telemetry and checks the answer; the tests flag an unlabelled command.

## State

- A module variable lives in the module that changes it. If another module needs to change it, move the variable
  there, or call a function of its module that does a whole step (`startShare` marks the share in flight, shows its
  progress and schedules it). A function that only assigns one field adds indirection and hides nothing.
- `SessionState`, `requests` and `activation` in `session-state.ts` are shared per-session records: features write
  their fields, and `session-state.ts` clears them.
- Key per-session state by session ID and clear it from the `session.end` handler. Keep process-wide state for
  caches that really span sessions.
- Model a lifecycle with phases as a discriminated union changed only by named transitions, as `feed.connection` in
  `watch.ts` is; other modules ask `liveFor`, `watchedSession` or `watchStatus`. Re-read the phase after each
  `await`. Independent flags stay flags.
- After an `await` that can yield to another event, check the work is still current: `stillActive(session)` for the
  recorded session, `feed.revision` for the watch.
- The band's drawing state stays in `band.tsx` and `rows.tsx` module variables, redrawn with `host.ui.invalidate()`.
  `$.state` atoms survive a hot reload, so moving it there is its own decision.

## Types

- Use `type` aliases for object shapes; an alias assigns to the engine's `JsonValue`, an interface doesn't.
- Parse untrusted input as `unknown` (`const value: unknown = JSON.parse(text)`) and narrow it with the `json.ts`
  guards and `commandErrorFromEnvelope`. A validator is a type guard or an assertion function. `any` appears only in
  tests, fakes and generated fixtures.
- Use `as` for `as const`, or with a comment saying why the type holds. Read saved bindings through
  `storedBinding` and `storedChildBinding`.
- Narrow locally rather than using a `!` whose reason is far away; a `!` right after its own check is fine.
- End a `switch` over a union with `default: { const unreachable: never = value; … }`.

## Errors

- Name error classes `…Error`, and add one only when a caller checks it with `instanceof`.
- Throw in feature code and turn errors into the engine's answer at the hook. A failure is a member of a tagged
  union (`{ kind: 'none'; reason }`), not a bare string.
- Give every hook that can block or refuse an explicit `.catch`. Hooks that record or observe fail open
  (`logHookFailure`, then `next(e)`), so recording never blocks someone's work; `prompt.submit` fails closed.
- An empty `catch` or `.catch(() => {})` that drops a side effect's failure has a comment saying why that is safe.
  A read that treats failure as absent, a parser's fallback, stopping a child process, and waiting for something to
  finish need none.
- Show a person `errorText(error)`; `String(error)` prefixes the class name, which suits debug logs only.
- User-facing text is product copy: change it only on purpose.

## Names and comments

- `$` is the engine, `host` the `Host` bound from it, and `e` the event; `session` is a Claude session ID,
  `thread` a Delta thread ID, `agentId` a Claude subagent ID.
- A comment moves with its code and stays true there. Check a claim about the engine against its types or
  `claude plugin validate` before writing it.

## Tests

- Unit-test pure functions directly, in a file named after their module, beside it.
- Test behaviour with the engine's test kit and `fakeThreads`, in the `describe` for its feature in
  `register.test.ts` or a feature's existing engine test file. Each test file runs in a process of its own that
  warms the plugin up again, so a new engine test file adds CPU that makes CI's timed tests flaky.
- Let the plugin run with `fake.settle()` and `fake.advance(ms)`, which wait until it has gone quiet, not
  `fake.clock.settle()` or `fake.clock.advance(ms)`, which a loaded machine can outlast. Wait for one specific
  condition with `fake.settleUntil(…)`.
- Reuse the helpers in `fake-thread-commands.ts`, and move a helper there once a second test file needs it.
- Assert on `ui.find` results: a missed match is `undefined`, not a failure.

## Formatting

There is no formatter: match the code around you, and keep formatting changes out of structural commits.

- No semicolons, 2-space indentation, trailing commas on multiline lists.
- Single quotes, or double quotes when the text contains an apostrophe.
- Names inside an import's braces sorted alphabetically, ignoring `type`.
- Wrap code past about 120 columns at a natural break. A user-facing string stays on one line, so it can be found
  by searching for its text.

## Before you finish

1. Run the checks in `AGENTS.md`. `claude plugin validate .` lists no `gating hook without .catch`.
2. In a refactor, the hooks `validate` lists and the `$` calls in source
   (`grep -rohE --include='*.ts*' '\$\.[a-z]+\.[a-zA-Z]+' hooks | sort -u`) stay the same.
3. Any change to user-visible text (`host.ui.log`, `{ drop }`, `{ text }`, band strings) is intended.
