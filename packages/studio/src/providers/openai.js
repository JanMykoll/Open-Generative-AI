// OpenAI Batch provider — gpt-image-2 bulk-gen.
// All traffic goes through Next.js proxy routes (`/api/openai/*`) because
// OpenAI does not expose browser CORS for `/v1/files` and `/v1/batches`.

export function getOpenAIKey() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('openai_key');
}

function authHeaders() {
  const key = getOpenAIKey();
  if (!key) throw new Error('OpenAI API key missing. Add it under Settings → OpenAI API Key.');
  return { 'x-openai-key': key };
}

function buildJsonl(prompts, opts) {
  const { quality = 'standard', size = '1024x1024', n = 1, model = 'gpt-image-2' } = opts || {};
  const lines = prompts.map((prompt, idx) => {
    const customId = `req-${idx}-${Date.now()}`;
    return JSON.stringify({
      custom_id: customId,
      method: 'POST',
      url: '/v1/images/generations',
      body: {
        model,
        prompt,
        n,
        size,
        quality,
        response_format: 'b64_json',
      },
    });
  });
  return lines.join('\n');
}

export async function submitGptImage2Batch(prompts, opts) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error('At least one prompt is required.');
  }
  if (prompts.length > 500) {
    throw new Error('Max 500 prompts per batch (UI cap).');
  }

  const jsonl = buildJsonl(prompts, opts);
  const blob = new Blob([jsonl], { type: 'application/jsonl' });

  // 1. Upload .jsonl as a file with purpose=batch.
  const fileForm = new FormData();
  fileForm.append('purpose', 'batch');
  fileForm.append('file', blob, 'batch-input.jsonl');

  const fileResp = await fetch('/api/openai/files', {
    method: 'POST',
    headers: authHeaders(),
    body: fileForm,
  });
  if (!fileResp.ok) {
    const t = await fileResp.text();
    throw new Error(`File upload failed: ${fileResp.status} — ${t.slice(0, 200)}`);
  }
  const fileJson = await fileResp.json();
  const inputFileId = fileJson.id;
  if (!inputFileId) throw new Error('No file id returned from /v1/files');

  // 2. Submit the batch.
  const batchBody = {
    input_file_id: inputFileId,
    endpoint: '/v1/images/generations',
    completion_window: '24h',
    metadata: { source: 'higgsfield-clone-bulk-gen', prompt_count: String(prompts.length) },
  };
  const batchResp = await fetch('/api/openai/batches', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(batchBody),
  });
  if (!batchResp.ok) {
    const t = await batchResp.text();
    throw new Error(`Batch submit failed: ${batchResp.status} — ${t.slice(0, 200)}`);
  }
  const batchJson = await batchResp.json();
  if (!batchJson.id) throw new Error('No batch id returned from /v1/batches');
  return batchJson;
}

export async function pollBatch(batchId) {
  const resp = await fetch(`/api/openai/batches/${batchId}`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Batch poll failed: ${resp.status} — ${t.slice(0, 200)}`);
  }
  return resp.json();
}

export async function cancelBatch(batchId) {
  const resp = await fetch(`/api/openai/batches/${batchId}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel' }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Batch cancel failed: ${resp.status} — ${t.slice(0, 200)}`);
  }
  return resp.json();
}

// Parses the output .jsonl returned by a `completed` batch and yields
// { custom_id, b64_png } rows.  Returns [] for empty / non-image outputs.
export async function downloadBatchResults(outputFileId) {
  const resp = await fetch(`/api/openai/files/${outputFileId}/content`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Output download failed: ${resp.status} — ${t.slice(0, 200)}`);
  }
  const text = await resp.text();
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const customId = parsed.custom_id;
      const datum = parsed.response?.body?.data?.[0];
      const b64 = datum?.b64_json;
      const url = datum?.url;
      if (b64 || url) rows.push({ custom_id: customId, b64_png: b64 || null, url: url || null });
    } catch {
      // skip malformed line
    }
  }
  return rows;
}
