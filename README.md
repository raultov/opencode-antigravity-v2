# opencode-antigravity-auth-v2

OpenCode **V2** adapter for [opencode-antigravity-auth](https://www.npmjs.com/package/opencode-antigravity-auth)
— Antigravity / Gemini CLI OAuth accounts, rotation and quota for the native `google` provider.

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

```sh
bun install && bun run build
```

Then replace the V1 plugin entry in `~/.config/opencode/opencode.json` with the built adapter:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-antigravity-v2/dist",
      "options": {
        "soft_quota_threshold_percent": 100
      }
    }
  ]
}
```

Your existing setup keeps working as-is: the adapter reads the same `~/.local/share/opencode/auth.json`
credential and `~/.config/opencode/antigravity-accounts.json` account pool the V1 plugin used, so
there is nothing to re-login.

## Options

| Option                          | Default    | Description                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------------ |
| `provider_id`                   | `"google"` | Provider whose requests are managed.                               |
| `soft_quota_threshold_percent`  | `100`      | Skip accounts past this quota share (`100` disables the guard).    |
| `account_selection_strategy`    | `"sticky"` | Upstream account selection strategy.                               |
| `max_rate_limit_wait_seconds`   | `300`      | How long a request waits for a free account before failing.        |
| `cli_first`                     | `false`    | Prefer Gemini CLI quota over Antigravity quota for Gemini models.  |
| `pid_offset_enabled`            | `false`    | Upstream per-account project offset behaviour.                     |

## What is and is not ported

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
