export const LOGICAL_WIDTH = 780;
export const LOGICAL_HEIGHT = 660;

// Canvas backing pixels are deliberately unrelated to world/cell coordinates.
export function createDisplay({ canvas, battle = canvas, onChange = () => {}, window: windowRef = globalThis.window, document: documentRef = globalThis.document } = {}) {
  let quality = 'auto', pixelRatio = 1, focused = false;
  function snapshot() {
    return { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT, pixelRatio, bufferWidth: canvas.width, bufferHeight: canvas.height, quality, focused };
  }
  function changed() { const value = snapshot(); onChange(value); return value; }
  function resize(options = {}) {
    if (Object.hasOwn(options, 'quality')) quality = ['auto', 'low', 'high'].includes(options.quality) ? options.quality : 'auto';
    const dpr = options.devicePixelRatio ?? windowRef?.devicePixelRatio ?? 1;
    pixelRatio = quality === 'high' ? 2 : quality === 'low' ? 1 : Number.isFinite(dpr) && dpr >= 1.5 ? 2 : 1;
    const width = LOGICAL_WIDTH * pixelRatio, height = LOGICAL_HEIGHT * pixelRatio;
    // Assigning width/height clears the drawing state, so avoid it on unchanged resizes.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (canvas.style) canvas.style.aspectRatio = `${LOGICAL_WIDTH} / ${LOGICAL_HEIGHT}`;
    return changed();
  }
  function focus(enabled = !focused) {
    focused = Boolean(enabled);
    battle?.classList?.toggle('focus-mode', focused);
    documentRef?.body?.classList?.toggle('arena-focus', focused);
    return changed();
  }
  const onResize = () => resize();
  windowRef?.addEventListener?.('resize', onResize);
  resize();
  return {
    resize,
    renderTransform(context = canvas.getContext?.('2d')) {
      context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      return snapshot();
    },
    focus,
    async fullscreen() {
      if (documentRef?.fullscreenElement && documentRef.exitFullscreen) {
        try { await documentRef.exitFullscreen(); focus(false); return true; }
        catch { focus(true); return false; }
      }
      focus(true);
      try {
        const target = typeof battle?.requestFullscreen === 'function' ? battle : canvas;
        if (typeof target?.requestFullscreen !== 'function') return false;
        await target.requestFullscreen();
        return true;
      } catch { return false; }
    },
    destroy() { windowRef?.removeEventListener?.('resize', onResize); }
  };
}
