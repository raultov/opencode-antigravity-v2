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

Your existing setup keeps working as-is: both entrypoints use the same `~/.local/share/opencode/auth.json`
credential and `~/.config/opencode/antigravity-accounts.json` account pool as the upstream plugin, so
there is nothing to re-login.

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

## What is and is not ported

This applies to V2 only. V1 runs the upstream plugin, so every upstream feature is there.

Ported: account selection and rotation, proactive token refresh, quota/rate-limit bookkeeping,
Antigravity vs Gemini CLI quota routing (including model `:antigravity` / `:cli` suffixes),
endpoint fallbacks on capacity errors, request rewriting (`cloudcode-pa.googleapis.com`, quota
headers, thinking options) and streamed response transformation.

Not yet ported: the `google_search` tool, the V1 `event` hook behaviours (image saving, debug
thinking injection), thinking warmup requests, and TUI toasts (logged instead).

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
