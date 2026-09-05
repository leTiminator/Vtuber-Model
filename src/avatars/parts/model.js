/**
 * Loads a baked model: the manifest that scripts/bake-model.mjs wrote and
 * every part's PNGs, decoded exactly as stored (no premultiply, no colour
 * conversion) so a texture holds the bytes the bake produced.
 */
export async function loadModel(base) {
  const manifest = await fetchJson(`${base}manifest.json`);
  const parts = await Promise.all(manifest.parts.map(async (part) => {
    const [image, marginImage] = await Promise.all([
      decode(`${base}${part.png}`), decode(`${base}${part.marginPng}`),
    ]);
    return { ...part, image, marginImage };
  }));
  return { ...manifest, parts };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function decode(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
}
