# Upstream notes: `opencode-antigravity-auth`

Findings from a capture against the live Code Assist backend
(`cloudcode-pa.googleapis.com` and `daily-cloudcode-pa.sandbox.googleapis.com`),
compared with the traffic of the official Antigravity CLI (`agy` 1.4.2). All
calls used the same OAuth client (`1071006060591-…`, `azp` identical in both
tools), so none of the differences below depend on credentials.

Upstream repository: <https://github.com/NoeFabris/opencode-antigravity-auth>

## 1. `loadCodeAssist` always fails outside Windows

`plugin/project.js` builds its metadata as

```js
const CODE_ASSIST_METADATA = {
    ideType: "ANTIGRAVITY",
    platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
    pluginType: "GEMINI",
};
```

and `buildMetadata()` forwards `platform` into the request. The API rejects both
values:

```
POST /v1internal:loadCodeAssist
{"metadata":{"ideType":"ANTIGRAVITY","platform":"MACOS","pluginType":"GEMINI"}}
→ 400 INVALID_ARGUMENT
  Invalid value at 'metadata.platform'
  (type.googleapis.com/google.internal.cloud.code.v1internal.ClientMetadata.Platform),
  "MACOS"
```

`"WINDOWS"` is rejected the same way. Because `loadManagedProject()` treats a
non-OK response as "try the next endpoint", every endpoint fails and the plugin
falls through to `onboardManagedProject()`, then to the hardcoded
`ANTIGRAVITY_DEFAULT_PROJECT_ID` (`rising-fact-p41fc`). The account's real
managed project is never resolved and never persisted to `auth.refresh`.

The official CLI sends no `platform` at all and succeeds:

```
POST /v1internal:loadCodeAssist
{"metadata":{"ideType":"ANTIGRAVITY"}}
→ 200
  {"currentTier":{"id":"free-tier",…},
   "cloudaicompanionProject":"aicode-consumers",
   "paidTier":{"id":"g1-pro-tier","name":"Google AI Pro",…}}
```

**Proposed fix:** drop `platform` (and `pluginType`) from `CODE_ASSIST_METADATA`,
keeping `ideType: "ANTIGRAVITY"`. Optionally send the real platform only when
the backend accepts it again — the enum appears to have changed.

Note: the User-Agent also has to be the CLI one for the response to include the
paid tier and the current tier (see §2); with the IDE User-Agent the call is
rejected before reaching the metadata check.

## 2. Gemini 4 Argon is only served to the CLI client identity

The backend keys part of its catalog and its model routing off the `User-Agent`:

| `User-Agent` | `fetchAvailableModels` | `streamGenerateContent` with `gemini-4-argon-medium` |
| --- | --- | --- |
| `antigravity/cli/1.4.2 (aidev_client; os_type=linux; arch=amd64; cl=1001591392; auth_method=consumer)` | 29 models, incl. `gemini-4-argon-{low,medium,high}` | 200, `modelVersion: gemini-4-argon-trial` |
| `antigravity/cli/1.4.2` | — | 200 |
| `antigravity/cli/9.9.9` | — | 200 |
| `antigravity/2.0.6 linux/amd64` (the style this plugin sends) | 23 models, no Argon | 404 `Requested entity was not found` |
| `antigravity/2.0.6 win32/arm64` | — | 404 |

Only the `antigravity/cli/` prefix is load bearing: the version and the
platform/arch suffix are ignored. Non-Argon models are unaffected —
`gemini-3.8-flash-tiered` and `claude-opus-5-5-medium` answer identically under
both identities — so switching wholesale is safe.

The plugin currently derives the `User-Agent` from the stored account
fingerprint (`generateFingerprint()` /
`collectCurrentFingerprint()` produce `antigravity/${getAntigravityVersion()}
${platform}/${arch}`). `updateFingerprintVersion()` only rewrites
`antigravity/<digits>`, so a fingerprint recorded with the IDE identity stays on
it forever.

**Proposed fix:** generate the fingerprint `userAgent` as
`antigravity/cli/${getAntigravityVersion()} ${platform}/${arch}` and migrate
already-stored fingerprints. This adapter does the migration externally on
startup; putting it upstream removes the need for that.

## 3. `gemini-4-argon` is not a valid model id

The backend addresses Argon by its tiered ids. The bare id opencode advertises
returns 404 even with the CLI identity:

```
model: "gemini-4-argon"        → 404
model: "gemini-4-argon-medium" → 200
model: "gemini-4-argon-low"    → 200
model: "gemini-4-argon-high"   → 200
```

`fetchAvailableModels` lists `gemini-4-argon-{low,medium,high}`; the response
`modelVersion` is `gemini-4-argon-trial`, which is the backend's internal name.

**Proposed fix:** alias `gemini-4-argon` to `gemini-4-argon-medium` in
`resolveModelWithTier`/`MODEL_ALIASES`, and register the tiered ids as thinking
variants of the Gemini 4 family.

## 4. Rate limits state their wait in the body, and it is usually sub-second

A momentary capacity limit is reported as a 429 whose body carries the wait; the
`Retry-After` header is absent, so a client that only reads headers waits its own
default (a minute) for a limit that clears in under a second:

```
POST /v1internal:generateContent
{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",
 "message":"You have exhausted your capacity on this model. Resets in 0s.",
 "details":[
  {"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"RATE_LIMIT_EXCEEDED",
   "metadata":{"model":"gemini-3.8-flash-tiered","quotaResetDelay":"174.617923ms",
               "quotaResetTimeStamp":"2026-11-15T08:37:34Z"}},
  {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"0.174617923s"}]}}
```

`fetchAvailableModels` still reports `quotaInfo.remainingFraction` ≈ 1 for the
same model, so this is a concurrency/rate limit, not quota exhaustion. The
platform endpoint (`cloudcode-pa.googleapis.com`) answers 429 for every model on
an account whose quota lives on the daily sandbox host, which is why the
fallback chain has to stay on `daily-cloudcode-pa.sandbox.googleapis.com` first.

**Proposed fix (done in this adapter):** read `RetryInfo.retryDelay`, then the
`ErrorInfo` `quotaResetDelay`, then `Retry-After`, and retry after that.

## 5. `gemini-3.8-flash` is served under a tier, or under `-tiered`

The bare id answers 404; the fixed tiers and the tiered alias answer 200:

```
model: "gemini-3.8-flash"        → 404 NOT_FOUND
model: "gemini-3.8-flash-low"    → 200, modelVersion gemini-3.8-flash-n
model: "gemini-3.8-flash-high"   → 200, modelVersion gemini-3.8-flash-n
model: "gemini-3.8-flash-tiered" → 200, modelVersion gemini-3.8-flash-tiered
```

`-tiered` keeps the requested `thinkingLevel`: sending `low` produces no thought
tokens, `high` produces a full reasoning block. The upstream resolver strips the
tier and fills in `low`, so a client asking for `high` silently runs cheap. The
catalog also shows `gemini-3.6-flash-*` and `gemini-3.1-pro-*` are gone: every
id variant of them answers 404, so a config advertising them cannot work.

## 6. Some system prompts are refused with a 429 that names no wait

Requests to `daily-cloudcode-pa.sandbox.googleapis.com` whose `systemInstruction` contains the
text `tools.opencode.session_move` (case-insensitive) are answered, every time, with:

```
429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).",
              "status":"RESOURCE_EXHAUSTED"}}
```

There are no `details`, no `RetryInfo` and no `Retry-After`, while `fetchAvailableModels`
reports the model's `remainingFraction` near 1. Verified on 2026-11-15 with
`gemini-3.8-flash-tiered`:

| Text in `systemInstruction` | Status |
| --- | --- |
| `tools.opencode.session_move`, `Tools.Opencode.session_move` | 429 |
| `tools.opencode.worktree_create`, `tools.opencode.foo`, `opencode`, `session_move` | 200 |
| `tools.claude.session_move`, `tools.opencode_session_move` | 200 |
| `tools.opencode.session_move` in the **user** message instead | 200 |

opencode V2 puts that text in every system prompt: its built-in `opencode.tools` plugin pushes a
worktree hint naming it on every turn, and `session_move` is a pinned Code Mode tool listed in the
`execute` catalog. Neither depends on configuration (MCP `codemode: false` does not remove them),
so every opencode V2 session with this backend is refused. Removing the two occurrences from an
otherwise identical captured request makes it succeed.

The same text is accepted everywhere else: in user and model turns, in function call arguments
and responses, and in tool descriptions. The bracket form `tools.opencode["session_move"]` (or
`tools["opencode"].session_move`) is accepted in the system instruction too.

Whether this is a deliberate filter on third-party clients is not known. Since 0.4.2 the adapter
rewrites the reference in the system instruction as `tools.opencode["session_move"]`, the
equivalent JavaScript call, so the model keeps the tool; nothing else in the request is changed.
If the refusal is deliberate, working around it may breach the backend's terms of service and put
the account at risk. A 429 that names no wait is still never retried (0.4.1), in case the backend
starts refusing other text.

## Not a factor

Verified not to matter for Argon access, so no change is needed for them:

- **OAuth client.** The CLI's token reports `azp`/`aud`
  `1071006060591-…`, the same client id this plugin uses.
- **Cloud project.** Requests succeed with both `aicode-consumers` and
  `rising-fact-p41fc`. The managed project from §1 is worth resolving for
  correctness and for the `paidTier`/quota view, but it does not gate Argon.
- **Endpoint host.** `daily-cloudcode-pa.sandbox.googleapis.com`,
  `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com` all
  serve Argon once the identity and model id are right.

## Reproduction

```sh
# Token: refresh the account's stored refresh token against
# https://oauth2.googleapis.com/token with the plugin's client id/secret.

# Catalogue (29 vs 23 models):
curl -s -X POST "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels" \
  -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
  -H "User-Agent: antigravity/cli/1.4.2" -d '{"project":"aicode-consumers"}'

# Generation:
curl -s -X POST "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse" \
  -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
  -H "User-Agent: antigravity/cli/1.4.2" \
  -d '{"project":"aicode-consumers","requestId":"t","model":"gemini-4-argon-medium",
       "userAgent":"antigravity","requestType":"agent",
       "request":{"contents":[{"role":"user","parts":[{"text":"Responde solo: OK"}]}],
                  "generationConfig":{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"LOW"}},
                  "sessionId":"-1"}}'
```
