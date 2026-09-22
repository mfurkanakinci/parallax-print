export interface ByteRange { readonly start: number; readonly end: number }

/** undefined = unsupported syntax (ignore); null = unsatisfiable range. */
export function parseRange(value: string | null, size: number): ByteRange | null | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** Skip/emit chunks without buffering the entire asset; cancel after the end. */
export function rangeStream(source: ReadableStream<Uint8Array>, range: ByteRange): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          controller.error(new Error('Media asset ended before its declared length.'));
          return;
        }
        const chunkStart = offset;
        offset += value.byteLength;
        if (offset <= range.start) continue;
        const from = Math.max(0, range.start - chunkStart);
        const to = Math.min(value.byteLength, range.end + 1 - chunkStart);
        if (to > from) controller.enqueue(value.subarray(from, to));
        if (offset > range.end) {
          controller.close();
          await reader.cancel();
        }
        return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function serveMedia(
  request: Request,
  fetchAsset: (request: Request) => Promise<Response>,
  sizes: Readonly<Record<string, number>>,
): Promise<Response> {
  const size = sizes[new URL(request.url).pathname];
  if (!size || !['GET', 'HEAD'].includes(request.method)) return fetchAsset(request);
  const headers = new Headers(request.headers);
  headers.delete('range');
  headers.delete('if-range');
  headers.set('accept-encoding', 'identity');
  const asset = await fetchAsset(new Request(request, { headers }));
  if (asset.status !== 200) return asset;
  const output = new Headers(asset.headers);
  output.set('Accept-Ranges', 'bytes');
  output.set('Content-Length', String(size));
  output.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (request.method === 'HEAD') return new Response(null, { headers: output });

  const ifRange = request.headers.get('if-range');
  const modified = asset.headers.get('last-modified');
  const current = !ifRange || (!ifRange.startsWith('W/') && ifRange === asset.headers.get('etag')) ||
    (modified !== null && Number.isFinite(Date.parse(ifRange)) && Date.parse(modified) <= Date.parse(ifRange));
  const range = current ? parseRange(request.headers.get('range'), size) : undefined;
  if (range === undefined) return new Response(asset.body, { headers: output });
  if (range === null) {
    await asset.body?.cancel();
    output.set('Content-Range', `bytes */${size}`);
    output.set('Content-Length', '0');
    return new Response(null, { status: 416, headers: output });
  }
  if (!asset.body) return new Response('Media unavailable', { status: 502 });
  output.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  output.set('Content-Length', String(range.end - range.start + 1));
  return new Response(rangeStream(asset.body, range), { status: 206, headers: output });
}
