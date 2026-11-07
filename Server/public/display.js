import { resolveArena } from './arena-geometry.js';
export const LOGICAL_WIDTH = 780;
export const LOGICAL_HEIGHT = 660;

// Canvas backing pixels are deliberately unrelated to world/cell coordinates.
export function createDisplay({ canvas, battle = canvas, fullscreenTarget = battle, onChange = () => {}, window: windowRef = globalThis.window, document: documentRef = globalThis.document } = {}) {
  let quality = 'auto', pixelRatio = 1, focused = false, arena = resolveArena();
  function snapshot() {
    return { width: arena.width * 60, height: arena.height * 60, pixelRatio, bufferWidth: canvas.width, bufferHeight: canvas.height, quality, focused };
  }
  function changed() { const value = snapshot(); onChange(value); return value; }
  function resize(options = {}) {
    if (Object.hasOwn(options, 'arena')) arena = resolveArena(options.arena);
    if (Object.hasOwn(options, 'quality')) quality = ['auto', 'low', 'high'].includes(options.quality) ? options.quality : 'auto';
    const dpr = options.devicePixelRatio ?? windowRef?.devicePixelRatio ?? 1;
    pixelRatio = quality === 'high' ? 2 : quality === 'low' ? 1 : Number.isFinite(dpr) && dpr >= 1.5 ? 2 : 1;
    const logicalWidth = arena.width * 60, logicalHeight = arena.height * 60;
    const width = logicalWidth * pixelRatio, height = logicalHeight * pixelRatio;
    // Assigning width/height clears the drawing state, so avoid it on unchanged resizes.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (canvas.style) canvas.style.aspectRatio = `${logicalWidth} / ${logicalHeight}`;
    battle?.style?.setProperty?.('--arena-ratio', `${arena.width} / ${arena.height}`);
    battle?.style?.setProperty?.('--arena-width', String(arena.width));
    battle?.style?.setProperty?.('--arena-height', String(arena.height));
    return changed();
  }
  function focus(enabled = !focused) {
    focused = Boolean(enabled);
    battle?.classList?.toggle('focus-mode', focused);
    documentRef?.body?.classList?.toggle('arena-focus', focused);
    return changed();
  }
  let layoutFrame = null;
  function cancelLayoutFrame() {
    if (layoutFrame !== null) windowRef?.cancelAnimationFrame?.(layoutFrame);
    layoutFrame = null;
  }
  function preservePartyGoal() {
    layoutFrame = null;
    if (canvas.dataset?.phase !== 'playing' || documentRef?.fullscreenElement || documentRef?.querySelector?.('dialog[open]')) return;
    const goal = battle?.querySelector?.('#partyGoalAnnouncement'), rect = goal?.getBoundingClientRect();
    // Leave deliberate lower-panel scrolling alone. Only retain an announcement
    // that remains visible but became clipped at the top during the resize.
    if (!rect?.width || rect.top >= 0 || rect.bottom <= 0) return;
    const delta = Math.floor(rect.top), height = windowRef?.innerHeight;
    const essentials = [canvas, ...(battle?.querySelectorAll?.('[data-action]') || [])];
    const fits = essentials.every(element => {
      const bounds = element.getBoundingClientRect();
      return !bounds.width || !bounds.height || bounds.top - delta >= 0 && bounds.bottom - delta <= height;
    });
    if (fits) windowRef?.scrollBy?.({top:delta,left:0,behavior:'instant'});
  }
  const onResize = () => {
    resize(); cancelLayoutFrame();
    // Browser focus/scroll anchoring can finish after responsive styles change.
    if (windowRef?.requestAnimationFrame) layoutFrame = windowRef.requestAnimationFrame(() => {
      layoutFrame = windowRef.requestAnimationFrame(preservePartyGoal);
    });
  };
  const onFullscreenChange = () => {
    focus(Boolean(documentRef?.fullscreenElement));
    resize();
  };
  windowRef?.addEventListener?.('resize', onResize);
  documentRef?.addEventListener?.('fullscreenchange', onFullscreenChange);
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
        const target = typeof fullscreenTarget?.requestFullscreen === 'function' ? fullscreenTarget : canvas;
        if (typeof target?.requestFullscreen !== 'function') return false;
        await target.requestFullscreen();
        return true;
      } catch { return false; }
    },
    destroy() { cancelLayoutFrame(); windowRef?.removeEventListener?.('resize', onResize); documentRef?.removeEventListener?.('fullscreenchange', onFullscreenChange); }
  };
}
