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

async function falSubscribe(endpoint, input, params) {
    const result = await fal.subscribe(endpoint, {
        input,
        logs: false,
        onQueueUpdate: (update) => {
            if (update.status === 'IN_QUEUE' && params?.onRequestId && update.request_id) {
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

export async function generateFalImage(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;
    const input = { prompt: params.prompt };
    if (params.aspect_ratio) input.image_size = mapAspectRatioToImageSize(params.aspect_ratio);
    if (params.seed && params.seed !== -1) input.seed = params.seed;
    if (params.num_images) input.num_images = params.num_images;
    return falSubscribe(endpoint, input, params);
}

export async function generateFalI2I(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;
    const input = {};
    if (params.prompt) input.prompt = params.prompt;
    const imagesList = params.images_list?.length > 0
        ? params.images_list
        : (params.image_url ? [params.image_url] : null);
    if (imagesList) {
        // Fal i2i endpoints commonly accept either `image_url` (single) or `image_urls` (list)
        if (imagesList.length > 1) input.image_urls = imagesList;
        else input.image_url = imagesList[0];
    }
    if (params.aspect_ratio) input.image_size = mapAspectRatioToImageSize(params.aspect_ratio);
    if (params.strength !== undefined) input.strength = params.strength;
    if (params.seed && params.seed !== -1) input.seed = params.seed;
    return falSubscribe(endpoint, input, params);
}

export async function generateFalVideo(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;
    const input = {};
    if (params.prompt) input.prompt = params.prompt;
    if (params.aspect_ratio) input.aspect_ratio = params.aspect_ratio;
    if (params.duration) input.duration = params.duration;
    if (params.resolution) input.resolution = params.resolution;
    if (params.seed && params.seed !== -1) input.seed = params.seed;
    return falSubscribe(endpoint, input, params);
}

export async function generateFalI2V(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;
    const input = {};
    if (params.prompt) input.prompt = params.prompt;
    if (params.image_url) input.image_url = params.image_url;
    if (params.last_image) input.tail_image_url = params.last_image;
    if (params.aspect_ratio) input.aspect_ratio = params.aspect_ratio;
    if (params.duration) input.duration = params.duration;
    if (params.resolution) input.resolution = params.resolution;
    if (params.seed && params.seed !== -1) input.seed = params.seed;
    return falSubscribe(endpoint, input, params);
}

export async function generateFalV2V(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;
    const input = {};
    if (params.prompt) input.prompt = params.prompt;
    if (params.video_url) input.video_url = params.video_url;
    if (params.image_url) input.image_url = params.image_url;
    if (params.seed && params.seed !== -1) input.seed = params.seed;
    return falSubscribe(endpoint, input, params);
}

export async function generateFalLipSync(model, params) {
    ensureConfigured();
    const endpoint = model?.endpoint || params.model;
    const input = {};
    if (params.audio_url) input.audio_url = params.audio_url;
    if (params.video_url) input.video_url = params.video_url;
    if (params.image_url) input.image_url = params.image_url;
    if (params.prompt) input.prompt = params.prompt;
    return falSubscribe(endpoint, input, params);
}
