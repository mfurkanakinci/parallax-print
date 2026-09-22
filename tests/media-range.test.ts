import { describe, it, expect, vi } from 'vitest';
import { parseRange, serveMedia } from '../cloudflare/media';

const sizes = { '/demo/movie.mp4': 10 };
function source() {
  return new Response(new TextEncoder().encode('abcdefghij'), {
    headers: { 'Content-Type': 'video/mp4', 'ETag': '"version-1"', 'Last-Modified': 'Tue, 15 Sep 2026 00:00:00 GMT' },
  });
}
const request = (range?: string, extra: HeadersInit = {}) => new Request('https://parallaxprint.app/demo/movie.mp4', {
  headers: { ...(range ? { Range: range } : {}), ...extra },
});

describe('media byte-range delivery', () => {
  it.each([
    ['bytes=0-3', { start: 0, end: 3 }], ['bytes=3-', { start: 3, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }], ['bytes=8-99', { start: 8, end: 9 }],
    ['bytes=10-', null], ['bytes=4-2', null], ['bytes=-0', null],
    ['bytes=0-1,4-5', undefined], ['garbage', undefined],
  ])('interprets %s against a ten-byte asset', (header, expected) => {
    expect(parseRange(header as string, 10)).toEqual(expected);
  });

  it('streams a requested section with correct 206 headers', async () => {
    const fetchAsset = vi.fn(async (input: Request) => {
      expect(input.headers.get('range')).toBeNull();
      return source();
    });
    const response = await serveMedia(request('bytes=3-6'), fetchAsset, sizes);
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 3-6/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe('defg');
  });

  it('handles suffix ranges and full-file requests', async () => {
    expect(await (await serveMedia(request('bytes=-3'), async () => source(), sizes)).text()).toBe('hij');
    const full = await serveMedia(request(), async () => source(), sizes);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Length')).toBe('10');
    expect(await full.text()).toBe('abcdefghij');
  });

  it('returns 416 with the complete size for an unsatisfiable range', async () => {
    const result = await serveMedia(request('bytes=100-200'), async () => source(), sizes);
    expect(result.status).toBe(416);
    expect(result.headers.get('Content-Range')).toBe('bytes */10');
    expect(await result.text()).toBe('');
  });

  it('ignores a stale If-Range validator and honors a current one', async () => {
    const stale = await serveMedia(request('bytes=2-3', { 'If-Range': '"old-version"' }), async () => source(), sizes);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('abcdefghij');
    const current = await serveMedia(request('bytes=2-3', { 'If-Range': '"version-1"' }), async () => source(), sizes);
    expect(current.status).toBe(206);
    expect(await current.text()).toBe('cd');
  });

  it('keeps HEAD bodyless and ignores its Range header', async () => {
    const input = new Request(request('bytes=2-3'), { method: 'HEAD' });
    const result = await serveMedia(input, async () => new Response(null, { headers: { 'Content-Type': 'video/mp4' } }), sizes);
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Length')).toBe('10');
    expect(result.body).toBeNull();
  });

  it('passes missing and conditional responses through', async () => {
    const missing = new Response('missing', { status: 404 });
    expect(await serveMedia(request(), async () => missing, sizes)).toBe(missing);
    const unchanged = new Response(null, { status: 304 });
    expect(await serveMedia(request(), async () => unchanged, sizes)).toBe(unchanged);
  });

  it('spans source chunks and cancels after the requested bytes', async () => {
    const chunks = ['ab', 'cdef', 'ghij'].map((text) => new TextEncoder().encode(text));
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); },
      cancel,
    });
    const result = await serveMedia(request('bytes=1-4'), async () => new Response(stream), sizes);
    expect(await result.text()).toBe('bcde');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
