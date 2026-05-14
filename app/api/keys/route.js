import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const keys = {};
  if (process.env.MUAPI_KEY)  keys.muapi  = process.env.MUAPI_KEY;
  if (process.env.FAL_KEY)    keys.fal    = process.env.FAL_KEY;
  if (process.env.OPENAI_KEY) keys.openai = process.env.OPENAI_KEY;
  return NextResponse.json(keys, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
