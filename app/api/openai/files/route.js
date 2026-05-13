import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request) {
  const apiKey = request.headers.get('x-openai-key');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-openai-key header' }, { status: 400 });
  }
  try {
    const incoming = await request.formData();
    const outgoing = new FormData();
    for (const [k, v] of incoming.entries()) outgoing.append(k, v);

    const resp = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: outgoing,
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
