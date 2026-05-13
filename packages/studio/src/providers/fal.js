import { fal } from '@fal-ai/client';

let configured = false;

export function getFalKey() {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('fal_key');
}

function ensureConfigured() {
    const key = getFalKey();
    if (!key) throw new Error('Fal API key missing. Add it under Settings → Fal API Key.');
    if (!configured || fal.__lastKey !== key) {
        fal.config({ credentials: key });
        fal.__lastKey = key;
        configured = true;
    }
}

function mapAspectRatioToImageSize(ar) {
    switch (ar) {
        case '1:1':  return 'square_hd';
        case '4:3':  return 'landscape_4_3';
        case '3:4':  return 'portrait_4_3';
        case '16:9': return 'landscape_16_9';
        case '9:16': return 'portrait_16_9';
        default:     return 'square_hd';
    }
}

function pickOutputUrl(result) {
    return result?.data?.images?.[0]?.url
        || result?.data?.image?.url
        || result?.data?.video?.url
        || result?.data?.url
        || null;
}

export async function generateFalImage(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;

    const input = { prompt: params.prompt };
    if (params.aspect_ratio) input.image_size = mapAspectRatioToImageSize(params.aspect_ratio);
    if (params.seed && params.seed !== -1) input.seed = params.seed;
    if (params.num_images) input.num_images = params.num_images;

    const result = await fal.subscribe(endpoint, {
        input,
        logs: false,
        onQueueUpdate: (update) => {
            if (update.status === 'IN_QUEUE' && params.onRequestId && update.request_id) {
                params.onRequestId(update.request_id);
            }
        },
    });

    const url = pickOutputUrl(result);
    return {
        ...result.data,
        url,
        outputs: url ? [url] : [],
        status: 'completed',
        provider: 'fal',
    };
}
