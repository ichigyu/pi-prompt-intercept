# pi-prompt-intercept

Burp-style provider-payload interceptor for [pi](https://pi.dev). It pauses each model provider request, shows the full JSON payload in a local browser UI, and only lets the request continue when you click **Forward**.

This is a research/debugging tool for understanding what your agent is about to send to the model.

## What It Does

- Hooks pi's `before_provider_request` extension event.
- Starts a local web UI at `http://127.0.0.1:47831`.
- Queues each provider request as `pending`.
- Renders provider payloads in human-readable tabs: Overview, System, Messages, Tools, Raw/Edit, and JSON Tree.
- Lets you inspect, edit, forward, or drop the payload.
- Supports `on`, `off`, and `once` modes so you can intercept every request, no requests, or only the next request.
- Writes minimal audit events to `.pi/prompt-intercept/events.jsonl`.

It does not proxy arbitrary network traffic. It only intercepts provider payloads inside pi's extension lifecycle.

## Install

Project-local install while developing:

```bash
pi -e ./src/index.ts
```

Or install as a pi package from this repository:

```bash
pi install git:github.com/ichigyu/pi-prompt-intercept
```

For local project auto-discovery, copy or symlink the extension into `.pi/extensions/`.

## Usage

1. Start pi with the extension loaded.
2. Send any prompt that reaches the model.
3. Open the UI shown in the pi notification:

```text
http://127.0.0.1:47831
```

4. Inspect the payload through the readable tabs:

- **Overview**: model, message/tool counts, approximate token estimate, scalar request parameters, and system prompt preview.
- **System**: extracted system/developer/instructions text.
- **Messages**: normalized conversation messages and tool call/result blocks.
- **Tools**: tool schemas with names, descriptions, and parameters.
- **Raw / Edit**: editable raw JSON payload.
- **JSON Tree**: structured payload tree.

5. Choose one action:

- **Forward**: send the original provider payload.
- **Forward Edited**: parse the editor JSON and send the edited payload.
- **Drop**: abort the provider request.
- **Disable**: stop intercepting new requests for this session.
- **Intercept Once**: intercept only the next provider request, then automatically switch back to off.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PI_PROMPT_INTERCEPT` | enabled | Set `0` to disable interception. |
| `PI_PROMPT_INTERCEPT_ONCE` | disabled | Set `1` to start in once mode. |
| `PI_PROMPT_INTERCEPT_HOST` | `127.0.0.1` | Bind host for the local UI. Keep this local unless you know what you are doing. |
| `PI_PROMPT_INTERCEPT_PORT` | `47831` | Port for the local UI. |
| `PI_PROMPT_INTERCEPT_TIMEOUT_MS` | `600000` | Auto-forward original payload after timeout. Set `0` to wait forever. |

Examples:

```bash
PI_PROMPT_INTERCEPT_TIMEOUT_MS=0 pi -e ./src/index.ts
PI_PROMPT_INTERCEPT=0 pi -e ./src/index.ts
PI_PROMPT_INTERCEPT_ONCE=1 pi -e ./src/index.ts
```

## Pi Commands

When loaded in interactive pi, the extension registers:

```text
/prompt-intercept-on
/prompt-intercept-off
/prompt-intercept-once
/prompt-intercept-status
```

## Security Notes

Provider payloads can include sensitive data:

- system prompts
- user messages
- project context
- file contents
- tool results
- image metadata

The server binds to `127.0.0.1` by default. Do not bind to `0.0.0.0` unless you understand the risk.

Add audit output to `.gitignore`:

```gitignore
.pi/prompt-intercept/
```

## Development

```bash
npm install
npm run typecheck
```

## Relation To claude-tap

`claude-tap` is a broader traffic inspection tool for multiple coding agents. `pi-prompt-intercept` is intentionally narrower: a minimal pi extension focused on interactive request forwarding from inside pi's provider request lifecycle.
