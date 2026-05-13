export const runtime = 'nodejs';

export async function GET(request, { params }) {
  const apiKey = request.headers.get('x-openai-key');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing x-openai-key header' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { id } = await params;
  const upstream = await fetch(`https://api.openai.com/v1/files/${id}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  // Stream the body straight through — output .jsonl can be huge.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
}
