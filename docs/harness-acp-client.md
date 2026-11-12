# Non-interactive ACP client for external workers

Import `AcpClient` from `@buihongduc132/pi-acp-agents/api`. Construct it with `harness: { onProgress }`, then call `connect()`, `initialize()`, `newSession()`, `prompt()` and `dispose()` in a `finally` block. This is an opt-in mode; existing clients retain their behavior.

`initialize()` returns the server's handshake, also available as `agentInfo`, including its advertised `agentCapabilities` and `authMethods`. An offered authentication method is not proof that authentication is required. The client does not call `authenticate` in this mode. RPC errors, including authentication-required errors, are propagated; the bridge must present them rather than claim a login occurred.

Every permission request is cancelled, even if an allow option is offered; there is no approval or deferred-resolution mechanism. `onProgress` receives metadata-only update notifications and permission summaries (bounded strings and at most 16 options, with an omitted count). It receives no thought text. Notifications are streamed, not stored; the consumer must bound any queue or history it maintains. `prompt()` returns only agent message text and the stop reason, never thought text. The existing optional `onSessionUpdate` callback still receives raw ACP updates, including thoughts: do not use it when that disclosure is unwanted. Progress callback failures do not grant permissions or interrupt the ACP call.

This mode starts an executable directly without a shell on every platform. Arguments are passed separately and are not interpreted as shell syntax. Configure a trusted absolute native executable path and fixed argument array; do not pass a shell command line or untrusted executable/configuration. On Windows, a shell wrapper such as a `.cmd` file is not itself a native executable. Resolve the installed wrapper and inspect its contents and package metadata **read-only** to identify the real executable or script entry point; if it launches a trusted Node script, use the absolute path to the trusted Node executable as `command` and the absolute script path followed by arguments as `args`. Do not execute the wrapper, log in, or invoke a model merely to discover this mapping. If the entry point cannot be established, report the blocker rather than guessing or enabling a shell. An unavailable/non-executable command rejects the connection or initialization.

This is not a sandbox: the spawned executable runs with the host user's privileges and environment and can perform actions without asking ACP permission. Restrict executable trust and use an independently appropriate OS sandbox where required. Capabilities are server claims, not proof that steering or session resumption works; neither is promised by this interface. ## Antigravity (`agy`)

On Windows, `agy` 1.5.6 installs a native executable (`%LOCALAPPDATA%\agy\bin\agy.EXE`, PE32+), so no wrapper mapping is needed: use its absolute path as `command` and `["acp"]` as `args`. A handshake-only check (`connect()` + `initialize()`, no session, no login, no model call) returned:

- `agentInfo`: `Antigravity ACP Server` 1.5.6, `protocolVersion` 1;
- `agentCapabilities`: `loadSession`, prompt images and embedded context (no audio), session `resume`/`close`/`load`/`list`/`additionalDirectories`;
- `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`.

With the user already signed in to `agy` (Google account, stored by the CLI itself), `connect()`, `initialize()`, `newSession()` and `prompt("Responda só: ok")` succeeded on 2026-11-12 without calling `authenticate`: reply `ok`, `stopReason` `end_turn`, about 10 s end to end, 4 `update` progress events. Permission requests and long tasks were not exercised live.
