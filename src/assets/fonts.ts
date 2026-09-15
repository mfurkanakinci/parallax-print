import latinUrl from '@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff?url';
import latinExtUrl from '@fontsource/instrument-sans/files/instrument-sans-latin-ext-400-normal.woff?url';

let cached: Promise<readonly ArrayBuffer[]> | null = null;

export function loadFontBytes(): Promise<readonly ArrayBuffer[]> {
  if (!cached) {
    cached = Promise.all(
      [latinUrl, latinExtUrl].map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Font fetch failed: ${response.status}`);
        }
        return response.arrayBuffer();
      }),
    );
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
