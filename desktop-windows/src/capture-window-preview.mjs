const DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Convert an Electron window thumbnail into bounded, in-memory picker preview data. */
export function captureWindowPreview(source, { maxDataUrlBytes = 512_000, maxWidth = 1920, maxHeight = 1080 } = {}) {
  const image = source?.thumbnail;
  if (typeof image?.isEmpty !== 'function' || image.isEmpty()
    || typeof image.getSize !== 'function' || typeof image.toDataURL !== 'function') return null;
  const size = image.getSize();
  if (!Number.isInteger(size?.width) || !Number.isInteger(size?.height)
    || size.width < 1 || size.height < 1 || size.width > maxWidth || size.height > maxHeight) return null;
  const dataURL = image.toDataURL();
  if (typeof dataURL !== 'string' || dataURL.length > maxDataUrlBytes || !DATA_URL.test(dataURL)) return null;
  return dataURL;
}
