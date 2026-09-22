import { serveMedia } from './media';
import sizes from './media-sizes.json';

export default {
  async fetch(request, env, context): Promise<Response> {
    try {
      const response = await serveMedia(request, (assetRequest) => env.ASSETS.fetch(assetRequest), sizes);
      const length = Number(response.headers.get('content-length'));
      if (!response.body || !Number.isSafeInteger(length) || length <= 0) return response;
      // Workers derive Content-Length from the stream, not a manual header.
      const fixed = new FixedLengthStream(length);
      context.waitUntil(response.body.pipeTo(fixed.writable).catch(() => {
        // Browser cancellation while seeking is normal; the stream propagates
        // genuine transport errors to the client that requested these bytes.
      }));
      return new Response(fixed.readable, response);
    } catch (error) {
      console.error(JSON.stringify({ event: 'media_delivery_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
      return new Response('Media delivery failed', { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
