import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request) {
  const apiKey = request.headers.get('x-openai-key');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-openai-key header' }, { status: 400 });
  }
  try {
    const body = await request.text();
    const resp = await fetch('https://api.openai.com/v1/batches', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
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
