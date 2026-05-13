# Studio: Multi-Provider Routing + OpenAI Batch Bulk-Gen

**Status**: Goal-ready spec for unattended `/goalrun`.
**Repo**: `A:/claude/apps/higgsfield-clone` (Open Generative AI / higgsfield-clone)
**Smoke-test budget cap**: $0.50 total in real API charges. Use the cheapest variant of every model for verification. **No video gen during smoke tests** — image-only.

---

## Why

Currently `generateImage` is the only path that respects a `provider` field — every other path (`generateI2I`, `generateVideo`, `generateI2V`, `generateV2V`, `processLipSync`) hardcodes muapi. Pricing audit (2026-05-13) showed fal and muapi each win on different models — neither is uniformly cheaper. And **OpenAI direct + Batch API is ~50% cheaper** than fal/muapi for gpt-image-2 at scale, but neither provider exposes batch.

## Scope (3 phases, all in scope for one goalrun)

### Phase A — Dual provider routing infrastructure

Wire `provider === 'fal'` check through every generate path, mirroring what `generateImage` already does in `packages/studio/src/muapi.js`. Extend `packages/studio/src/providers/fal.js` with:

- `generateFalI2I(model, params)` — image-to-image (Flux Kontext etc.)
- `generateFalVideo(model, params)` — text-to-video (Seedance, Veo, Kling, etc.)
- `generateFalI2V(model, params)` — image-to-video
- `generateFalV2V(model, params)` — video-to-video
- `generateFalLipSync(model, params)` — lip sync if any fal model supports it; skip otherwise

Each routes via `fal.subscribe(endpoint, { input, onQueueUpdate })`. Reuse `ensureConfigured()` and `pickOutputUrl()`. Output shape must match muapi's: `{ url, outputs: [url], status: 'completed', provider: 'fal', ...rawData }`.

Touch points:
- `packages/studio/src/muapi.js` lines 51–163 — add the `if (modelInfo?.provider === 'fal') return generateFalX(...)` guard at the top of each function.
- `packages/studio/src/providers/fal.js` — extend.

### Phase B — Per-model cheapest-default selection (data + UI)

Add a `price_usd` and (where dual-hosted) `alt_provider` field to model entries in `packages/studio/src/models.js`. Where a model exists on both providers, **duplicate the entry** (one per provider) with the same display name but different `id`/`endpoint`/`provider`/`price_usd`. UI shows price next to model name in the picker. Default selection = lowest priced variant per model family.

Pricing data to plug in (verified 2026-05-13):

| Model family | fal price | muapi price | Default |
|---|---|---|---|
| Flux Schnell | $0.003/MP | $0.003/gen | muapi (cheaper >1MP) |
| Flux Dev | $0.025/MP | $0.015/gen | muapi |
| Flux Pro | $0.05/MP | n/a | fal only |
| Nano Banana family | $0.039/img | not listed publicly | fal |
| Imagen 4 / Fast / Ultra | $0.05 / $0.02 / $0.06 | not listed publicly | fal |
| GPT Image 2 (high 1024²) | $0.211 | not listed publicly | **see Phase C** |
| Seedance Lite t2v | $0.18 (5s) | $0.10 | muapi |
| Seedance Pro t2v | $0.62 (5s) | $0.18 | muapi (3.4×) |
| Seedance Pro Fast | n/a | $0.06 | muapi only |
| Veo 3 | $2.50 (5s) | $2.50 | tie — default muapi |
| Veo 3 Fast | $0.50 (5s) | $0.60 | fal |
| Veo 3.1 Fast | $0.50 (5s) | $0.60 | fal |
| Veo 3.1 Lite | $0.50 (5s) | $0.30 | muapi |
| Kling v2.1 Std | $0.28 (5s) | $0.225 | muapi |
| Kling v2.1 Master t2v | $1.40 (5s) | $1.20 | muapi |
| Kling v2.5 Turbo Pro | $0.35 (5s) | $0.45 | fal |
| Kling v2.6 Pro | $0.35 (5s) | $0.90 | fal (2.6×) |
| Hailuo 02 Std t2v | $0.225 (5s) | $0.30 | fal |
| Hailuo 02 Pro | $0.40 (5s) | $0.60 | fal |
| Hailuo 2.3 Pro | n/a | $0.63 | muapi only |
| Wan 2.2 | $0.30 (5s) | $0.30 | tie — default muapi |
| Wan 2.5 | $0.50 (5s) | $0.65 | fal |
| Wan 2.6 | not on fal | $0.65 | muapi only |
| Hunyuan Video | $0.40 | $0.15 | muapi (2.6×) |
| Sora 2 (t2v) | $0.10/s | not in pricing | fal |
| Runway Gen-3 | not on fal | $0.09 | muapi only |

Heuristic: muapi wins on Flux/Seedance/Kling-master/Hunyuan/Veo3.1-Lite. fal wins on Kling-turbo/Hailuo/Wan2.5+/Sora 2/Imagen.

UI: in the model picker (`StandaloneShell.js` and image-studio components), show `Model Name — $X.XX` and a small provider badge. Persist user override per model in localStorage key `model_provider_overrides`.

### Phase C — OpenAI Batch bulk-gen for gpt-image-2

The expensive piece. New "Bulk Generate" surface for asynchronous batch jobs.

**Settings**: add a third API key field, `openai_key`, mirroring the fal key UI in `components/StandaloneShell.js` lines 340–380. App should boot if any of the three keys is set.

**Server proxy**: OpenAI does not support browser CORS for `/v1/files`, `/v1/batches`, etc. Create Next.js API routes that proxy with the user's key from a request header `x-openai-key`:
- `POST app/api/openai/files/route.js` → proxies multipart upload to `https://api.openai.com/v1/files`
- `POST app/api/openai/batches/route.js` → proxies POST to `/v1/batches`
- `GET app/api/openai/batches/[id]/route.js` → proxies GET to `/v1/batches/{id}`
- `GET app/api/openai/files/[id]/content/route.js` → streams output file

**Provider module**: `packages/studio/src/providers/openai.js`:
```js
export async function submitGptImage2Batch(prompts, opts) {
  // opts: { quality: 'standard' | 'hd', size: '1024x1024' | '2048x2048', n: 1 }
  // 1. Build .jsonl Blob (one POST per prompt to /v1/images/generations, response_format: 'b64_json')
  // 2. POST to /api/openai/files (purpose: 'batch')
  // 3. POST to /api/openai/batches (endpoint: '/v1/images/generations', completion_window: '24h')
  // 4. Return batch_id
}
export async function pollBatch(batchId) { /* GET /api/openai/batches/{id}; statuses: validating|in_progress|finalizing|completed|failed */ }
export async function downloadBatchResults(outputFileId) { /* GET /api/openai/files/{id}/content; parse jsonl; return [{ custom_id, b64_png }] */ }
```

**UI surface**: new tab "Bulk Gen" in the top nav (`components/StandaloneShell.js`). Components:
- Prompt input: textarea, one prompt per line, max 500 lines per batch (well under 50K hard cap).
- Quality picker: standard / hd
- Size picker: 1024² / 1792×1024 / 2048²
- "Submit Batch" button → calls `submitGptImage2Batch`, persists `{ id, created_at, status, prompt_count }` to localStorage key `openai_batches`.
- "Active Batches" list: rows with batch ID, status, age, "Refresh" button. Auto-poll every 2 min while any are non-terminal.
- On `completed`: pull output, render thumbnails grid. Download-all as zip button.

**Footguns to handle** (from API verification):
1. Output .jsonl can be huge — stream from the proxy, don't buffer in memory. Use `Response` body streaming on the Next.js side.
2. `response_format: 'b64_json'` → PNG. Decode client-side via `data:image/png;base64,...`. **Don't persist images to localStorage** (5MB quota); use IndexedDB or just hold in memory and rely on user downloading.
3. `response_format: 'url'` URLs expire in 1h — only use if user is actively in app; otherwise b64_json.
4. Batch can take 1–6h (24h SLA). UI must work across page reloads — that's why job IDs go to localStorage.

## Acceptance criteria

1. **Phase A**: every fal-prefixed model in `models.js` generates successfully end-to-end (image, i2i, video, i2v, v2v if applicable). Output URL renders in the studio gallery. **Smoke-test only the image path** (cost cap). Document in the commit message which paths are wired but un-tested.
2. **Phase B**: model picker shows both providers for shared models with prices and a checkmark on the cheaper default. localStorage override persists across reload. One overridden model + one default model both generate successfully in a single session.
3. **Phase C**: with an OpenAI key in Settings, "Bulk Gen" tab accepts 2 prompts, submits a real batch, the batch ID appears in Active Batches with status `validating` or `in_progress`. **Don't wait for completion in the smoke test** (1–6h SLA); just verify submission and status polling. Render a `completed` thumbnail grid using a mocked output if needed for screenshot verification.

## Smoke-test plan (token-thrift)

Browser test via Playwright MCP on `http://localhost:3001/studio` (or 3000 if free):

1. Set all three keys in localStorage via JS evaluation. Reload.
2. Generate ONE image with **Flux Schnell @ 1024×1024 via muapi** ($0.003) → verify image renders.
3. Generate ONE image with **Flux Schnell @ 1024×1024 via fal** ($0.003) → verify image renders. Confirms provider switching works.
4. Submit OpenAI Batch with TWO prompts at `standard` quality 1024² → poll until status reaches `validating` or `in_progress`. Verify localStorage `openai_batches` entry. **Do not wait for completion.**
5. Screenshot the Bulk Gen tab with the active batch row visible.

**Total real spend: ~$0.006 + Batch submission (~$0.10 if it runs to completion — but we won't wait for it; cancel batch via API after the test to avoid the charge).** Hard ceiling: $0.50.

## Out of scope (do not do)

- Don't add a 4th provider. fal + muapi + OpenAI is the set.
- Don't refactor `submitAndPoll` — it works, leave it alone.
- Don't change muapi's existing model entries except to add `provider: 'muapi'` and `price_usd` fields.
- Don't build credit/balance tracking for OpenAI — out of scope for this run.
- Don't try to batch-process fal or muapi models — neither offers a batch discount; this feature is OpenAI-specific.
- Don't run video smoke tests. Image-only verification.

## Deliverable

A single PR (or commit on `main` if PR is overkill) titled:
`feat(studio): multi-provider routing + per-model cheapest-default + OpenAI Batch bulk-gen`

Commit message includes:
- Summary of what was wired (and what wasn't smoke-tested, with reason).
- Pricing snapshot date (2026-05-13).
- Link to this spec.
- Any deviations from the spec and why.

## Notes for the goalrun agent

- Dev server might already be running on `:3001` (PID `bbiw8gp74` from the audit session). If port 3001 is taken, use whatever Next chooses.
- The fal key, muapi key, and OpenAI key are all stored in the user's browser localStorage. **Do not commit any keys to the repo.** Pull them from localStorage during smoke tests via Playwright JS evaluation. If a key isn't present in localStorage when the smoke test runs, skip that smoke and document the skip in the commit message.
- This app's CLAUDE.md (project root) doesn't exist yet — feel free to drop one summarizing the provider routing architecture once it's done.
- The previous fal-only commit was `a010903 feat(studio): add fal.ai provider with Flux Schnell`. Build on top of that.
