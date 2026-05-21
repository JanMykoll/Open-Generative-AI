#!/usr/bin/env node
/**
 * recreate-video.mjs — IG/URL/local video → split into clips → V2V "recreate" each.
 *
 * Pipeline:
 *   1. resolve input: http(s) URL → yt-dlp download; else use local file
 *   2. ffprobe metadata
 *   3. ffmpeg split into fixed-length clips
 *   4. per clip: upload to Cloudflare R2 (public URL) → muapi V2V (Kling
 *      motion-control) with a prompt → poll → download the recreated clip
 *   5. optional: ffmpeg-concat the recreated clips back into one mp4
 *
 * Keys are read from ~/.claude/secrets/.env (never hard-coded, never logged):
 *   MUAPI_KEY, CLOUDFLARE_R2_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *
 * Usage:
 *   node scripts/recreate-video.mjs <ig-url|local.mp4> [opts]
 *     --provider <p>   v2v provider: 'muapi' (default, paid) | 'comfyui' (local, $0)
 *     --clip <sec>     clip length, default 5
 *     --model <id>     v2v model, default kling-v3.0-pro-motion-control (muapi only)
 *     --prompt <text>  prompt applied to every clip (per-clip prompts: see
 *                      --prompts-file, a JSON array indexed by clip number)
 *     --prompts-file <path>  JSON array of per-clip prompts
 *     --only <n>       process only the first N clips (cheap test run)
 *     --no-recreate    download + split only, no provider spend (dry run)
 *     --concat         stitch recreated clips into one final.mp4
 *     --workdir <dir>  default ./.recreate/<timestamp>
 *
 *   ComfyUI provider (KAN-582): local I2V on the 4090, $0/clip.
 *     env COMFYUI_URL  default http://localhost:8188
 *     env COMFYUI_WORKFLOW  path to workflow JSON (default scripts/comfyui-workflows/ltx-video-i2v.json)
 *     Workflow params (defaults work for 5s @ 24fps, IG-style 9:16):
 *       --cf-width <px>   default 544
 *       --cf-height <px>  default 960
 *       --cf-fps <int>    default 24
 *       --cf-length <n>   default 121 (must be 8k+1)
 *       --cf-seed <int>   default random
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const pexec = promisify(execFile);
const MUAPI_BASE = 'https://api.muapi.ai';
const R2_BUCKET = 'congruent-storage';
const R2_PUBLIC = 'https://videos.congruentfunnels.com';

function loadSecrets({ needFal = false, needMuapi = true, needR2 = true } = {}) {
  const p = path.join(homedir(), '.claude', 'secrets', '.env');
  const env = {};
  // ComfyUI-only path can skip the file entirely if it doesn't exist
  if (!needFal && !needMuapi && !needR2) {
    try { for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }} catch {}
    return env;
  }
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const required = [];
  if (needR2) required.push('CLOUDFLARE_R2_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID');
  if (needFal) required.push('FAL_KEY');
  if (needMuapi) required.push('MUAPI_KEY');
  for (const k of required) {
    if (!env[k]) throw new Error(`Missing ${k} in ~/.claude/secrets/.env`);
  }
  return env;
}

// Submit + poll an I2V generation on fal Seedance 2.0.
// fal queue API contract:
//   POST  https://queue.fal.run/<endpoint>           {input}   -> { request_id, ... }
//   GET   https://queue.fal.run/<endpoint>/requests/<id>/status -> { status }
//   GET   https://queue.fal.run/<endpoint>/requests/<id>        -> { video: { url } }
async function falSeedanceI2V(endpoint, body, falKey, onSubmit) {
  const headers = { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' };
  const submit = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`fal submit ${submit.status}: ${submitText.slice(0, 300)}`);
  const sd = JSON.parse(submitText);
  const id = sd.request_id;
  if (onSubmit) onSubmit(sd);
  if (!id) throw new Error(`fal submit returned no request_id: ${submitText.slice(0, 200)}`);
  // Use the canonical URLs fal returns — building them by hand breaks on
  // multi-segment model ids (the queue app id != the full submit path).
  const statusUrl = sd.status_url || `https://queue.fal.run/${endpoint}/requests/${id}/status`;
  const responseUrl = sd.response_url || `https://queue.fal.run/${endpoint}/requests/${id}`;

  await new Promise(r => setTimeout(r, 3000));
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const sr = await fetch(statusUrl, { headers });
    if (!sr.ok) {
      if (sr.status >= 500) continue;
      throw new Error(`fal status ${sr.status} (req=${id}): ${(await sr.text()).slice(0, 200)}`);
    }
    const sdata = await sr.json();
    const st = (sdata.status || '').toUpperCase();
    if (st === 'COMPLETED') {
      const rr = await fetch(responseUrl, { headers });
      const rdata = await rr.json();
      const out = rdata.video?.url || rdata.url || rdata.output?.url || rdata.outputs?.[0]?.url;
      if (!out) throw new Error(`fal completed but no video url: ${JSON.stringify(rdata).slice(0, 300)}`);
      return out;
    }
    if (['FAILED', 'ERROR', 'CANCELLED'].includes(st)) {
      throw new Error(`fal gen ${st} (req=${id}): ${JSON.stringify(sdata).slice(0, 300)}`);
    }
  }
  throw new Error(`fal poll timed out (req=${id})`);
}

function parseArgs(argv) {
  const a = {
    provider: 'muapi',
    clip: 5, model: 'kling-v3.0-pro-motion-control', concat: false,
    noRecreate: false, only: 0, prompt: '', promptsFile: '', workdir: '',
    // Seedance 2.0 (fal) one-shot mode
    seedance: false, ref2v: false, duration: 12, resolution: '720p', tier: 'fast',
    keyframeAt: 0, // seconds into source; default first frame
    // ComfyUI provider knobs (KAN-582). 9:16, 5s @ 24fps defaults.
    cfWidth: 544, cfHeight: 960, cfFps: 24, cfLength: 121, cfSeed: 0,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--provider') a.provider = argv[++i];
    else if (x === '--clip') a.clip = +argv[++i];
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--prompt') a.prompt = argv[++i];
    else if (x === '--prompts-file') a.promptsFile = argv[++i];
    else if (x === '--only') a.only = +argv[++i];
    else if (x === '--no-recreate') a.noRecreate = true;
    else if (x === '--concat') a.concat = true;
    else if (x === '--workdir') a.workdir = argv[++i];
    else if (x === '--seedance') a.seedance = true;
    else if (x === '--ref2v') { a.seedance = true; a.ref2v = true; }
    else if (x === '--duration') a.duration = +argv[++i];
    else if (x === '--resolution') a.resolution = argv[++i];
    else if (x === '--tier') a.tier = argv[++i];
    else if (x === '--keyframe-at') a.keyframeAt = +argv[++i];
    else if (x === '--cf-width') a.cfWidth = +argv[++i];
    else if (x === '--cf-height') a.cfHeight = +argv[++i];
    else if (x === '--cf-fps') a.cfFps = +argv[++i];
    else if (x === '--cf-length') a.cfLength = +argv[++i];
    else if (x === '--cf-seed') a.cfSeed = +argv[++i];
    else rest.push(x);
  }
  a.input = rest[0];
  if (!['muapi', 'comfyui'].includes(a.provider)) {
    throw new Error(`unknown --provider ${a.provider} (expected 'muapi' or 'comfyui')`);
  }
  return a;
}

// Seedance 2.0 fal pricing — verified 2026-05 (https://fal.ai/models/bytedance/seedance-2.0)
const SEEDANCE_PRICE_PER_SEC = { standard: 0.3024, fast: 0.2419 };
function seedanceCost(duration, tier) {
  return (SEEDANCE_PRICE_PER_SEC[tier] || SEEDANCE_PRICE_PER_SEC.fast) * duration;
}
function seedanceEndpoint(tier) {
  // NOTE: no `fal-ai/` prefix — Seedance is a `bytedance/`-namespaced model on fal.
  return tier === 'fast'
    ? 'bytedance/seedance-2.0/fast/image-to-video'
    : 'bytedance/seedance-2.0/image-to-video';
}
function seedanceRefEndpoint(tier) {
  return tier === 'fast'
    ? 'bytedance/seedance-2.0/fast/reference-to-video'
    : 'bytedance/seedance-2.0/reference-to-video';
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function downloadInput(input, workdir) {
  if (/^https?:\/\//i.test(input)) {
    const out = path.join(workdir, 'source.%(ext)s');
    console.log(`[1/5] yt-dlp downloading ${input}`);
    sh('yt-dlp', ['-f', 'mp4/bestvideo*+bestaudio/best', '--merge-output-format', 'mp4',
                  '-o', out, input]);
    const f = readdirSync(workdir).find(f => f.startsWith('source.'));
    if (!f) throw new Error('yt-dlp produced no file');
    return path.join(workdir, f);
  }
  if (!existsSync(input)) throw new Error(`Local file not found: ${input}`);
  console.log(`[1/5] using local file ${input}`);
  return input;
}

function probe(file) {
  const j = JSON.parse(sh('ffprobe', ['-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', file]));
  const v = j.streams.find(s => s.codec_type === 'video') || {};
  return { dur: +j.format.duration, w: v.width, h: v.height,
           fps: eval(v.r_frame_rate || '0') || 0 };
}

function splitClips(file, clipLen, dir) {
  mkdirSync(dir, { recursive: true });
  console.log(`[3/5] splitting into ${clipLen}s clips`);
  sh('ffmpeg', ['-y', '-i', file, '-c', 'copy', '-map', '0',
    '-f', 'segment', '-segment_time', String(clipLen),
    '-reset_timestamps', '1', path.join(dir, 'clip_%03d.mp4')]);
  return readdirSync(dir).filter(f => /^clip_\d+\.mp4$/.test(f)).sort();
}

async function r2Upload(localPath, key, env) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${key}`;
  sh('curl', ['-s', '-X', 'PUT', url,
    '-H', `Authorization: Bearer ${env.CLOUDFLARE_R2_API_TOKEN}`,
    '-H', 'Content-Type: video/mp4',
    '--data-binary', `@${localPath}`]);
  return `${R2_PUBLIC}/${key}`;
}

function extractFirstFrame(clipPath, outPath) {
  sh('ffmpeg', ['-y', '-i', clipPath, '-vframes', '1', '-q:v', '2', outPath]);
  return outPath;
}

async function muapiV2V(model, videoUrl, imageUrl, prompt, key, onSubmit) {
  const payload = { video_url: videoUrl };
  if (imageUrl) payload.image_url = imageUrl;
  if (prompt) payload.prompt = prompt;
  const submit = await fetch(`${MUAPI_BASE}/api/v1/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(payload),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`muapi submit ${submit.status}: ${submitText.slice(0, 300)}`);
  const sd = JSON.parse(submitText);
  const id = sd.request_id || sd.id;
  if (onSubmit) onSubmit(sd);
  if (!id) return sd.outputs?.[0] || sd.url;

  // Predictions sometimes return 400 for ~5-15s right after submit while the
  // record propagates. Tolerate transient 4xx with bounded retries.
  let transient = 0;
  await new Promise(r => setTimeout(r, 5000)); // initial settle
  for (let i = 0; i < 900; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const rr = await fetch(`${MUAPI_BASE}/api/v1/predictions/${id}/result`,
      { headers: { 'x-api-key': key } });
    if (!rr.ok) {
      const body = await rr.text().catch(() => '');
      if (rr.status >= 500 || (rr.status === 400 && transient < 8)) {
        transient++;
        continue;
      }
      throw new Error(`poll ${rr.status} (req=${id}): ${body.slice(0, 200)}`);
    }
    transient = 0;
    const d = await rr.json();
    const st = (d.status || '').toLowerCase();
    if (['completed', 'succeeded', 'success'].includes(st))
      return d.outputs?.[0] || d.url || d.output?.url;
    if (['failed', 'error'].includes(st)) throw new Error(`gen failed (req=${id}): ${JSON.stringify(d.error || d)}`);
  }
  throw new Error(`muapi poll timed out (req=${id})`);
}

// ── ComfyUI provider (KAN-582): local I2V on Jan's 4090, $0/clip ────────────
// Default workflow: WAN 2.2 TI2V-5B (separate UNET+CLIP+VAE loaders). Chosen over
// LTX-Video because LTX's CLIP-less checkpoint segfaults torch's storage layer on
// this Windows box (CheckpointLoaderSimple → access violation); WAN's split files
// load cleanly. ltx-video-i2v.json is kept for when the torch/safetensors issue is
// resolved — point COMFYUI_WORKFLOW at it to switch.
// Input: first-frame .jpg (already extracted for the Kling path) + prompt.
// Output: SaveVideo node writes an mp4 to ComfyUI's output/ dir; we /view-fetch it.
const COMFYUI_URL_DEFAULT = 'http://localhost:8188';
const COMFYUI_WORKFLOW_DEFAULT = 'scripts/comfyui-workflows/wan22-ti2v-5b-i2v.json';

async function comfyuiUploadImage(comfyUrl, localImagePath) {
  const buf = readFileSync(localImagePath);
  const fd = new FormData();
  // Node's undici Blob accepts a Buffer
  fd.append('image', new Blob([buf], { type: 'image/jpeg' }), path.basename(localImagePath));
  fd.append('type', 'input');
  fd.append('subfolder', '');
  fd.append('overwrite', 'true');
  const r = await fetch(`${comfyUrl}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`comfyui upload ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.name || path.basename(localImagePath);
}

async function comfyuiSubmitAndPoll(comfyUrl, workflow, onSubmit) {
  const submit = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`comfyui /prompt ${submit.status}: ${submitText.slice(0, 400)}`);
  const sd = JSON.parse(submitText);
  const id = sd.prompt_id;
  if (!id) throw new Error(`comfyui no prompt_id: ${submitText.slice(0, 200)}`);
  if (onSubmit) onSubmit({ prompt_id: id });

  // Generation can take a few minutes on a 4090 for 121 frames @ 30 steps.
  // Poll history endpoint; ComfyUI populates it once the job finishes.
  await new Promise(r => setTimeout(r, 4000));
  for (let i = 0; i < 600; i++) {  // 600 * 2s = 20min max
    await new Promise(r => setTimeout(r, 2000));
    const hr = await fetch(`${comfyUrl}/history/${id}`);
    if (!hr.ok) continue;
    const h = await hr.json();
    const entry = h[id];
    if (!entry) continue;
    const status = entry.status || {};
    if (status.status_str === 'error') {
      throw new Error(`comfyui job error (${id}): ${JSON.stringify(status.messages || []).slice(0, 400)}`);
    }
    if (!entry.outputs) continue;
    // Find SaveVideo / SaveAnimatedWEBP / image output across any node
    for (const [nodeId, out] of Object.entries(entry.outputs)) {
      const files = [].concat(out.videos || [], out.gifs || [], out.images || []);
      const vid = files.find(f => /\.(mp4|webm|webp|mov|mkv)$/i.test(f.filename));
      if (vid) return { ...vid, prompt_id: id, node: nodeId };
    }
  }
  throw new Error(`comfyui poll timed out (prompt_id=${id})`);
}

async function comfyuiDownload(comfyUrl, file, destPath) {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || '',
    type: file.type || 'output',
  });
  const r = await fetch(`${comfyUrl}/view?${params}`);
  if (!r.ok) throw new Error(`comfyui /view ${r.status}: ${file.filename}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

function buildComfyWorkflow(templatePath, vars) {
  const tpl = readFileSync(templatePath, 'utf8');
  // Bare numeric placeholders (no quotes) for ints; quoted for strings.
  // JSON.stringify on the prompt strings handles quoting + escaping.
  const subs = {
    '{{IMAGE}}': vars.image,
    '{{PROMPT}}': vars.prompt,
    '{{NEGATIVE}}': vars.negative,
  };
  let out = tpl;
  for (const [k, v] of Object.entries(subs)) {
    // Replace `"{{KEY}}"` with JSON-encoded string, anywhere in template.
    out = out.split(`"${k}"`).join(JSON.stringify(v ?? ''));
  }
  // Numeric placeholders: replace bare `{{KEY}}` with literal number.
  const numSubs = {
    '{{WIDTH}}': vars.width,
    '{{HEIGHT}}': vars.height,
    '{{LENGTH}}': vars.length,
    '{{FPS}}': vars.fps,
    '{{SEED}}': vars.seed,
  };
  for (const [k, v] of Object.entries(numSubs)) {
    out = out.split(k).join(String(v));
  }
  const parsed = JSON.parse(out);
  delete parsed._meta;  // ComfyUI rejects unknown top-level keys
  return parsed;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.input) { console.error('usage: recreate-video.mjs <ig-url|local.mp4> [opts]'); process.exit(1); }
  // ComfyUI is fully local — don't require muapi/r2 keys for that path.
  const env = a.provider === 'comfyui'
    ? loadSecrets({ needFal: false, needMuapi: false, needR2: false })
    : loadSecrets({ needFal: a.seedance, needMuapi: !a.seedance, needR2: true });
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const workdir = a.workdir || path.join(process.cwd(), '.recreate', run);
  mkdirSync(workdir, { recursive: true });
  const outdir = path.join(workdir, 'out');
  mkdirSync(outdir, { recursive: true });

  const src = await downloadInput(a.input, workdir);
  const meta = probe(src);
  console.log(`[2/5] ${meta.dur.toFixed(1)}s ${meta.w}x${meta.h} @${meta.fps.toFixed(1)}fps`);

  // ── Seedance 2.0 one-shot I2V (fal) ──────────────────────────────────────
  if (a.seedance) {
    const validDur = [4, 5, 6, 8, 10, 12, 15];
    if (!validDur.includes(a.duration))
      throw new Error(`--duration must be one of ${validDur.join(',')}`);
    if (!a.prompt) throw new Error('--prompt is required for --seedance (use /seedance-prompt to build one)');
    const cost = seedanceCost(a.duration, a.tier).toFixed(2);
    const endpoint = a.ref2v ? seedanceRefEndpoint(a.tier) : seedanceEndpoint(a.tier);
    console.log(`[3/5] Seedance 2.0 ${a.ref2v ? 'reference-to-video' : 'I2V'} (${a.tier}, ${a.resolution}) ${a.duration}s ≈ $${cost}`);
    console.log(`      endpoint: ${endpoint}`);

    let body;
    if (a.ref2v) {
      // Upload the whole source clip → pass as video_urls[0]; prompt references @Video1.
      const vidKey = `videos/recreate/${run}/source-ref.mp4`;
      const vurl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/congruent-storage/objects/${vidKey}`;
      sh('curl', ['-s', '-X', 'PUT', vurl,
        '-H', `Authorization: Bearer ${env.CLOUDFLARE_R2_API_TOKEN}`,
        '-H', 'Content-Type: video/mp4',
        '--data-binary', `@${src}`]);
      const refVideoUrl = `${R2_PUBLIC}/${vidKey}`;
      console.log(`      reference video → ${refVideoUrl}`);
      body = {
        prompt: a.prompt,
        video_urls: [refVideoUrl],
        duration: a.duration,
        resolution: a.resolution,
        aspect_ratio: '9:16',
        generate_audio: false,
      };
    } else {
      // Extract keyframe at --keyframe-at seconds
      const frame = path.join(workdir, 'keyframe.jpg');
      sh('ffmpeg', ['-y', '-ss', String(a.keyframeAt), '-i', src, '-frames:v', '1', '-q:v', '2', frame]);
      const frameKey = `videos/recreate/${run}/keyframe.jpg`;
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/congruent-storage/objects/${frameKey}`;
      sh('curl', ['-s', '-X', 'PUT', url,
        '-H', `Authorization: Bearer ${env.CLOUDFLARE_R2_API_TOKEN}`,
        '-H', 'Content-Type: image/jpeg',
        '--data-binary', `@${frame}`]);
      const imageUrl = `${R2_PUBLIC}/${frameKey}`;
      console.log(`      keyframe → ${imageUrl}`);
      body = {
        prompt: a.prompt,
        image_url: imageUrl,
        duration: a.duration,
        resolution: a.resolution,
        generate_audio: false,
      };
    }
    writeFileSync(path.join(workdir, 'fal-body.json'), JSON.stringify(body, null, 2));
    console.log(`[4/5] submitting to fal (you've ALREADY approved spending $${cost})`);
    const resultUrl = await falSeedanceI2V(endpoint, body, env.FAL_KEY, (sd) => {
      console.log(`      req_id=${sd.request_id}`);
      writeFileSync(path.join(workdir, 'pending.jsonl'),
        JSON.stringify({ provider: 'fal', endpoint, ...sd, cost_quoted: cost }) + '\n');
    });
    if (!resultUrl) throw new Error('no result url from fal');
    const outFile = path.join(outdir, 'final.mp4');
    sh('curl', ['-sL', '-o', outFile, resultUrl]);
    console.log(`[5/5] ✓ ${outFile}`);
    writeFileSync(path.join(workdir, 'manifest.json'),
      JSON.stringify({ src, meta, provider: 'fal-seedance-2.0', endpoint,
                       duration: a.duration, resolution: a.resolution, tier: a.tier,
                       cost_usd: cost, out: outFile, body }, null, 2));
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  const clipsDir = path.join(workdir, 'clips');
  let clips = splitClips(src, a.clip, clipsDir);
  const total = clips.length;
  if (a.only > 0) clips = clips.slice(0, a.only);
  console.log(`    ${total} clips total; processing ${clips.length}`);

  const perClip = a.promptsFile && existsSync(a.promptsFile)
    ? JSON.parse(readFileSync(a.promptsFile, 'utf8')) : [];

  if (a.noRecreate) {
    console.log(`[dry-run] split only. Clips in ${clipsDir}`);
    writeFileSync(path.join(workdir, 'manifest.json'),
      JSON.stringify({ src, meta, total, clips, model: a.model }, null, 2));
    return;
  }

  const done = [];

  // ── ComfyUI provider branch (KAN-582): local I2V, $0 ─────────────────────
  if (a.provider === 'comfyui') {
    const comfyUrl = process.env.COMFYUI_URL || COMFYUI_URL_DEFAULT;
    const wfPath = process.env.COMFYUI_WORKFLOW
      ? path.resolve(process.env.COMFYUI_WORKFLOW)
      : path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
                  'comfyui-workflows', path.basename(COMFYUI_WORKFLOW_DEFAULT));
    if (!existsSync(wfPath)) throw new Error(`workflow not found: ${wfPath}`);
    // Sanity-ping ComfyUI
    const ping = await fetch(`${comfyUrl}/system_stats`).catch(() => null);
    if (!ping || !ping.ok) throw new Error(`ComfyUI not reachable at ${comfyUrl} — start with A:\\claude\\apps\\comfyui-pipelines\\start-comfyui.bat`);
    console.log(`[4/5] ComfyUI provider @ ${comfyUrl} (workflow ${path.basename(wfPath)})`);
    console.log(`      ${a.cfWidth}x${a.cfHeight} ${a.cfLength}f @${a.cfFps}fps, cost=$0/clip`);

    for (let i = 0; i < clips.length; i++) {
      const name = clips[i];
      const local = path.join(clipsDir, name);
      const prompt = perClip[i] || a.prompt || 'cinematic, high quality, sharp focus, natural motion';
      console.log(`      clip ${i + 1}/${clips.length} ${name}`);
      const framePath = path.join(clipsDir, name.replace('.mp4', '.frame.jpg'));
      extractFirstFrame(local, framePath);
      const uploadedName = await comfyuiUploadImage(comfyUrl, framePath);
      const seed = a.cfSeed || Math.floor(Math.random() * 2 ** 31);
      const prefix = `recreate/${run}/${name.replace('.mp4', '')}`;
      const wf = buildComfyWorkflow(wfPath, {
        image: uploadedName,
        prompt,
        negative: 'low quality, worst quality, blurry, jpeg artifacts, distorted, watermark, text',
        width: a.cfWidth, height: a.cfHeight, length: a.cfLength, fps: a.cfFps, seed,
      });
      const t0 = Date.now();
      const file = await comfyuiSubmitAndPoll(comfyUrl, wf, (sd) => {
        console.log(`      prompt_id=${sd.prompt_id} (seed=${seed})`);
        writeFileSync(path.join(workdir, 'pending.jsonl'),
          (existsSync(path.join(workdir, 'pending.jsonl'))
            ? readFileSync(path.join(workdir, 'pending.jsonl'), 'utf8') : '') +
          JSON.stringify({ clip: name, provider: 'comfyui', ...sd, seed }) + '\n');
      });
      const outFile = path.join(outdir, name.replace('.mp4', '.recreated.mp4'));
      await comfyuiDownload(comfyUrl, file, outFile);
      console.log(`      ✓ ${outFile} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      done.push(outFile);
    }

    if (a.concat && done.length > 1) {
      const listFile = path.join(workdir, 'concat.txt');
      writeFileSync(listFile, done.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      const final = path.join(workdir, 'final.mp4');
      sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', final]);
      console.log(`[5/5] stitched → ${final}`);
    }
    writeFileSync(path.join(workdir, 'manifest.json'),
      JSON.stringify({ src, meta, total, processed: clips.length,
                       provider: 'comfyui', comfyui_url: comfyUrl,
                       workflow: path.basename(wfPath),
                       cf: { width: a.cfWidth, height: a.cfHeight, length: a.cfLength, fps: a.cfFps },
                       out: done }, null, 2));
    console.log(`Done. Outputs in ${outdir}`);
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  for (let i = 0; i < clips.length; i++) {
    const name = clips[i];
    const local = path.join(clipsDir, name);
    const key = `videos/recreate/${run}/${name}`;
    const prompt = perClip[i] || a.prompt || '';
    console.log(`[4/5] clip ${i + 1}/${clips.length} ${name} → R2`);
    const pub = await r2Upload(local, key, env);
    // Motion-control models also need image_url — extract & upload first frame
    let imgUrl = '';
    const modelNeedsImage = /motion-control/.test(a.model);
    if (modelNeedsImage) {
      const framePath = path.join(clipsDir, name.replace('.mp4', '.frame.jpg'));
      extractFirstFrame(local, framePath);
      const frameKey = `videos/recreate/${run}/${path.basename(framePath)}`;
      const frameUrlCmd = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${frameKey}`;
      sh('curl', ['-s', '-X', 'PUT', frameUrlCmd,
        '-H', `Authorization: Bearer ${env.CLOUDFLARE_R2_API_TOKEN}`,
        '-H', 'Content-Type: image/jpeg',
        '--data-binary', `@${framePath}`]);
      imgUrl = `${R2_PUBLIC}/${frameKey}`;
      console.log(`      first frame → ${imgUrl}`);
    }
    console.log(`      muapi ${a.model} (prompt: ${prompt ? prompt.slice(0, 60) : '—'})`);
    let submitInfo = null;
    const resultUrl = await muapiV2V(a.model, pub, imgUrl, prompt, env.MUAPI_KEY, (sd) => {
      submitInfo = sd;
      const usd = sd.cost?.amount_usd;
      console.log(`      req_id=${sd.request_id || sd.id}${usd ? ` cost=$${usd}` : ''}`);
      // Persist request_id immediately so a crash doesn't lose track of paid jobs
      const pending = path.join(workdir, 'pending.jsonl');
      writeFileSync(pending,
        (existsSync(pending) ? readFileSync(pending, 'utf8') : '') +
        JSON.stringify({ clip: name, ...sd }) + '\n');
    });
    if (!resultUrl) throw new Error(`no output url for ${name}`);
    const outFile = path.join(outdir, name.replace('.mp4', '.recreated.mp4'));
    sh('curl', ['-sL', '-o', outFile, resultUrl]);
    console.log(`      ✓ ${outFile}`);
    done.push(outFile);
  }

  if (a.concat && done.length > 1) {
    const listFile = path.join(workdir, 'concat.txt');
    writeFileSync(listFile, done.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const final = path.join(workdir, 'final.mp4');
    sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', final]);
    console.log(`[5/5] stitched → ${final}`);
  }
  writeFileSync(path.join(workdir, 'manifest.json'),
    JSON.stringify({ src, meta, total, processed: clips.length, model: a.model, out: done }, null, 2));
  console.log(`Done. Outputs in ${outdir}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
