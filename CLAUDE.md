# higgsfield-clone — Claude notes

## Paid API approval — ALWAYS estimate + ask first

This project uses **third-party APIs that bill per request** — Kling V2V (via muapi / fal), other image/video providers, ad-platform spend, anything billed per token / second / credit. For any such call:

1. Surface the per-call cost (read from the provider's docs or a test endpoint — don't guess).
2. Multiply by however many calls the run will make.
3. Show the total estimate and what we get for it.
4. Wait for explicit "go" before sending the paying request.

No exceptions for "small" amounts — even $1.63 for a single clip counts.

For pipelines that fan out (e.g. recreate-video with N clips): run one paid call as a sanity check only after Jan approves the per-clip cost, then ask again before fanning out to the rest.

If the workload can be served by a free local alternative (4090 + ComfyUI, local LLM, self-hosted Whisper, etc.), mention that as an option before proposing the paid path.

### Scope clarification

This rule applies **only to third-party APIs billed per request** in this project's workflows. It does **NOT** apply to:

- Claude Code / Anthropic Claude usage in general — Jan is on the **Claude Max 20x subscription** (flat-rate, no per-call billing).
- Anything that runs locally (LM Studio, ComfyUI, local Whisper, the 4090).

If you're unsure whether a given call is per-request-billed, ask before firing it.

### Why this rule exists

Jan got surprised by a $1.63 Kling V2V charge on 2026-05-20 in this project (`KAN-545` follow-up). The rule was originally written into the global `~/.claude/CLAUDE.md`, but it kept misfiring on regular Claude usage in other projects (e.g. blocking sensible Claude-via-Max calls in janmux's meta view). Moved here 2026-05-23 to its actual project scope. If a future project starts billing per request from a third-party API, copy this rule into that project's `CLAUDE.md` — don't re-globalize it.
