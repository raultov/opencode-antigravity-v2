# opencode-antigravity-auth-v2

OpenCode **V1 and V2** plugin for [opencode-antigravity-auth](https://www.npmjs.com/package/opencode-antigravity-auth)
— Antigravity / Gemini CLI OAuth accounts, rotation and quota for the native `google` provider.

One package serves both generations. On V1, the default export's `server` entry runs the upstream
plugin unchanged. On V2, its `id`/`setup` entries run the adapter described below.

The upstream package is a V1 plugin: it supplies credentials through V1's `auth` hook using a
custom `fetch` that owns account rotation, quota gating and request rewriting. V2 removed that
hook and its native providers do not accept a fetch takeover, so the same behaviour is rebuilt
here on the native request hooks, reusing the upstream package's internals (account pool, token
refresh, request preparation, response transformation) unchanged.

| upstream V1 fetch                    | this adapter                          |
| ------------------------------------ | ------------------------------------- |
| pick account, wait out cooldowns     | `http.request` (before the send)      |
| refresh expired access tokens        | `http.request`                        |
| rewrite URL/headers/body per quota   | `http.request` (request replacement)  |
| transform the streamed response      | `http.response` (response swap)       |
| retry with the next account/endpoint | `retry` hook                          |

## Install

Replace the `opencode-antigravity-auth` entry in `~/.config/opencode/opencode.json`.

### opencode V2

```jsonc
{
  "plugins": [
    {
      "package": "@raultov/opencode-antigravity-v2",
      "options": {
        "soft_quota_threshold_percent": 100
      }
    }
  ]
}
```

### opencode V1

```jsonc
{
  "plugin": ["@raultov/opencode-antigravity-v2"]
}
```

On V1 the upstream plugin reads its settings from `~/.config/opencode/antigravity.json` (or
`.opencode/antigravity.json` in the project), not from the plugin options. Options set in
`opencode.json` are logged as a warning and otherwise ignored. Like
[opencode-hooks-plugin](https://github.com/raultov/opencode-hooks-plugin), the dual entrypoint
needs V1 1.18.29 or newer.

Your existing setup keeps working as-is: both entrypoints use the same
`~/.config/opencode/antigravity-accounts.json` account pool as the upstream plugin, so there is
nothing to re-login. On V2 the adapter needs no credential besides that pool. It still reads a
V1 `~/.local/share/opencode/auth.json` entry when one exists.

### Signing in

Run `opencode auth login`, pick Google and choose **OAuth with Google (Antigravity)**. The same
option appears when you connect Google from the TUI. Each sign-in adds the account to the pool,
so repeat it to add more accounts.

On V2 the redirect back to `localhost:51121` is detected automatically. Over SSH, in a dev
container, or with `OPENCODE_HEADLESS` set, you paste the redirect URL or the code instead. The
same happens when port 51121 is busy.

To load a local build instead, run `bun install && bun run build` and point the entry at the
`dist/` directory.

## Options

These apply to the V2 adapter.

| Option                          | Default    | Description                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------------ |
| `provider_id`                   | `"google"` | Provider whose requests are managed.                               |
| `soft_quota_threshold_percent`  | `100`      | Skip accounts past this quota share (`100` disables the guard).    |
| `account_selection_strategy`    | `"sticky"` | Upstream account selection strategy.                               |
| `max_rate_limit_wait_seconds`   | `300`      | How long a request waits for a free account before failing.        |
| `cli_first`                     | `false`    | Prefer Gemini CLI quota over Antigravity quota for Gemini models.  |
| `pid_offset_enabled`            | `false`    | Upstream per-account project offset behaviour.                     |

## Gemini 4 Argon

Gemini 4 Argon is reachable only under two conditions, both handled here:

1. **Client identity.** The Code Assist backend serves Argon only to the
   Antigravity CLI identity (`antigravity/cli/...`). Requests stamped with the
   IDE identity (`antigravity/<version> <os>/<arch>`) get a 404 for every
   Argon id. The adapter forces the CLI identity onto the account fingerprint,
   which request preparation turns into the outgoing `User-Agent`, and migrates
   already-stored fingerprints on startup.
2. **Model id.** The backend addresses Argon by its tiered ids
   (`gemini-4-argon-low|medium|high`); the bare `gemini-4-argon` that opencode
   lists is not a valid id. The adapter aliases it to `gemini-4-argon-medium`
   and leaves the tiered ids untouched.

Both entrypoints get the fixes. On V1 the upstream plugin sends the fingerprint
`User-Agent` verbatim and never aliases model ids, so the adapter migrates the
stored fingerprints before the pool loads and rewrites the model id in the
requests before delegating to the upstream fetch. The Gemini 4 Argon quota is
separate from the main Gemini quota on Pro plans, as reported by `agy`.

## Gemini 3.x Flash

Versioned Gemini 3 flash models (`gemini-3.8-flash`) are not served under their bare id: it
answers 404. They are served under two kinds of tiered ids:

- **Fixed tiers** (`gemini-3.8-flash-low|medium|high`), where the id pins the tier.
- **The tiered alias** (`gemini-3.8-flash-tiered`), which takes the tier from the request's
  `thinkingLevel` and is how one model entry can offer low, medium and high variants.

The upstream resolver strips the tier off every Gemini 3 flash id and fills in its own default
level (`low`), which silently downgrades a caller that asked for `high`. On V2 the adapter puts
the level the caller asked for back after request preparation, and restores the tier of a bare
id from it (`gemini-3.8-flash` + `high` → `gemini-3.8-flash-high`). The alias keeps its id: it
is the id that reads the level. The older `gemini-3-flash` is the opposite case — bare id plus
`thinkingLevel` — and gets the same level restoration.

This fix is V2 only: on V1 the upstream fetch prepares and sends the request itself, so there
is nothing to rewrite on the way out.

## Tool schemas

opencode V2 sends function declarations with `parametersJsonSchema`, the field Google's API
documents for a full JSON Schema. The upstream transform only reads `parameters` (what V1's SDK
sent), so without help every declaration reaches the backend with no schema, preparation fills
in `{ "type": "OBJECT", "properties": {} }`, and the model calls tools with no arguments at
all — `read` is invoked with `{}` and the turn cannot proceed.

The adapter moves the schema onto `parameters` and runs the upstream's
`cleanJSONSchemaForAntigravity` over it (refs, `const`, `anyOf`/`oneOf`, nullable unions and
unsupported keywords are turned into hints the proto accepts) before preparation. A request
that already carries `parameters` is left untouched, and each repaired body is logged at debug
level.

## Rate limits

Antigravity states the wait for a retryable response in the response **body**, not in a
`Retry-After` header:

```json
{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[
  {"@type":"…/google.rpc.ErrorInfo","metadata":{"quotaResetDelay":"174.617923ms"}},
  {"@type":"…/google.rpc.RetryInfo","retryDelay":"0.174617923s"}]}}
```

That is usually a model's per-minute capacity ("You have exhausted your capacity on this model.
Resets in 0s"), not quota exhaustion, and it clears in well under a second. The adapter reads
the `RetryInfo`/`ErrorInfo` delay (falling back to `Retry-After`, then to a minute), books the
account against that wait and retries after it. A wait longer than
`max_rate_limit_wait_seconds` is not retried at all: the turn fails with the backend's message
instead of stalling through it.

A 429 that names **no** wait at all (`"Resource has been exhausted (e.g. check quota)."`, with
no `details` and no `Retry-After`) is not a capacity limit: the backend answers it to requests it
refuses outright, and every retry fails the same way. The adapter does not retry it and does not
mark the account rate-limited (which would otherwise push the next request onto Gemini CLI quota,
where an account without a Gemini Code Assist licence gets `403 SUBSCRIPTION_REQUIRED`). The error
shown in opencode carries a note saying so. See `UPSTREAM.md` §6 for the one cause identified so
far.

## System prompt

The backend refuses (with the 429 above) any request whose system prompt contains
`tools.opencode.session_move`, and opencode V2 puts that text in every system prompt: a worktree
hint from its built-in tools plugin and the Code Mode catalog. Neither can be turned off from
configuration, so without help no opencode V2 turn reaches the model.

The adapter rewrites that reference in the system instruction as
`tools.opencode["session_move"]`. It is the same JavaScript call, so the model can still use the
tool from `execute`. The conversation, tool calls and tool descriptions are not touched; the
backend accepts the text there. Each rewrite is logged at debug level.

> **Risk.** It is not known whether this refusal is a deliberate filter on third-party clients.
> If it is, working around it may breach Google's terms for Antigravity and put the account at
> risk. Use it knowing that.

## What is and is not ported

This applies to V2 only. V1 runs the upstream plugin, so every upstream feature is there.

Ported: the OAuth sign-in that adds accounts to the pool, account selection and rotation,
proactive token refresh, quota/rate-limit bookkeeping,
Antigravity vs Gemini CLI quota routing (including model `:antigravity` / `:cli` suffixes),
endpoint fallbacks on capacity errors, request rewriting (`cloudcode-pa.googleapis.com`, quota
headers, thinking options) and streamed response transformation.

Also handled by the adapter rather than the upstream: the CLI client identity, the
Gemini 4 Argon model alias and the Gemini 3.x flash thinking tier described above, the tool
schema field opencode V2 uses, the retry delay Antigravity states in its error bodies, the
system prompt reference the backend refuses, and the
managed Cloud project resolution (`ensureProjectContext`) that V2 previously skipped — it used
to send an empty project id, which preparation replaced with a synthetic project no
subscription is attached to.

Not yet ported: the `google_search` tool, the V1 `event` hook behaviours (image saving, debug
thinking injection), thinking warmup requests, and TUI toasts (logged instead). The V1
`opencode auth login` menu that lists, refreshes or replaces existing accounts is not ported
either. V2 sign-ins only add accounts, as V1's `/connect` does.

## Development

```sh
bun test        # unit tests against injected fakes
bun run typecheck
bun run check   # biome lint + format
bun run build   # dist/
```

## License

MIT (adapter code). The reused `opencode-antigravity-auth` internals keep their own MIT license
and carry their own terms-of-service warning for Google accounts — read its README before use.
