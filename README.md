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

Versioned Gemini 3 flash models (`gemini-3.8-flash`) are served only under their tiered
ids (`gemini-3.8-flash-low|medium|high`); the bare id gets a 404. The older
`gemini-3-flash` is the opposite: bare id plus `thinkingLevel`. The upstream resolver
treats both the same way and always strips the tier, so on V2 the adapter restores it
after request preparation, taking the tier from the thinking level that goes on the wire
(variants included) and falling back to `-low`. This fix is V2 only: on V1 the upstream
fetch prepares and sends the request itself, so there is no point to rewrite it.

## What is and is not ported

This applies to V2 only. V1 runs the upstream plugin, so every upstream feature is there.

Ported: the OAuth sign-in that adds accounts to the pool, account selection and rotation,
proactive token refresh, quota/rate-limit bookkeeping,
Antigravity vs Gemini CLI quota routing (including model `:antigravity` / `:cli` suffixes),
endpoint fallbacks on capacity errors, request rewriting (`cloudcode-pa.googleapis.com`, quota
headers, thinking options) and streamed response transformation.

Also handled by the adapter rather than the upstream: the CLI client identity and the
Gemini 4 Argon model alias described above, and the managed Cloud project resolution
(`ensureProjectContext`) that V2 previously skipped — it used to send an empty project id,
which preparation replaced with a synthetic project no subscription is attached to.

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
