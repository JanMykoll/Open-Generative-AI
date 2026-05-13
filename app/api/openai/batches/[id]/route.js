import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

async function proxy(request, params, method, path = '') {
  const apiKey = request.headers.get('x-openai-key');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-openai-key header' }, { status: 400 });
  }
  const { id } = await params;
  const url = `https://api.openai.com/v1/batches/${id}${path}`;
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
  });
}

export async function GET(request, { params }) {
  return proxy(request, params, 'GET');
}

// POST /api/openai/batches/[id] with body { action: 'cancel' } → cancels the batch.
export async function POST(request, { params }) {
  const apiKey = request.headers.get('x-openai-key');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-openai-key header' }, { status: 400 });
  }
  let body = {};
  try { body = await request.json(); } catch {}
  if (body?.action !== 'cancel') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }
  const { id } = await params;
  const resp = await fetch(`https://api.openai.com/v1/batches/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
  });
}
