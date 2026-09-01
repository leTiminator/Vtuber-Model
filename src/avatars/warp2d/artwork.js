/**
 * Loading and remembering the user's artwork.
 *
 * The image is kept in its own localStorage entry rather than in the settings
 * blob, so a large picture cannot bloat every settings write — and if it will
 * not fit, only the artwork is lost, not the whole configuration.
 */
const KEY = 'vtuber-model/artwork/v1';

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be decoded as an image.'));
    img.src = src;
  });
}

export async function readFile(file) {
  if (!/^image\//.test(file.type)) throw new Error('Pick a PNG, JPG or WebP image.');
  const dataURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
  return { image: await loadImage(dataURL), dataURL };
}

export function remember(dataURL) {
  try {
    localStorage.setItem(KEY, dataURL);
    return true;
  } catch {
    // Over quota, or storage unavailable. The model still works this session.
    return false;
  }
}

export async function recall() {
  let dataURL;
  try {
    dataURL = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!dataURL) return null;
  try {
    return { image: await loadImage(dataURL), dataURL };
  } catch {
    return null;
  }
}

export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do */ }
}
