import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';

const sizes = {};
for (const name of (await readdir('public/demo')).sort()) {
  if (/\.(mp4|webm)$/.test(name)) sizes[`/demo/${name}`] = (await stat(`public/demo/${name}`)).size;
}
await mkdir('cloudflare', { recursive: true });
await writeFile('cloudflare/media-sizes.json', `${JSON.stringify(sizes, null, 2)}\n`);
