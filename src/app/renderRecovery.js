/**
 * Render-loop recovery for transient zero-size canvases.
 *
 * Cesium stops its default render loop after any render error. A canvas that
 * collapses to 0×0 for a moment — a window minimise, a fullscreen transition,
 * a docked panel animating closed — can raise a framebuffer error that would
 * otherwise leave the globe frozen until reload. This guard watches for that
 * case only: when a render error happens while the canvas has no area, it
 * waits for the canvas to regain a real size, resizes the viewer and restarts
 * the loop. Errors on a normally sized canvas are real bugs and are left
 * stopped (and reported), and restarts are bounded so a persistent fault
 * cannot spin.
 */

export const DEFAULT_MAX_RECOVERIES = 5;
export const DEFAULT_RECOVERY_WINDOW_MS = 60_000;
export const DEFAULT_POLL_MS = 250;

/** Whether a canvas currently has no drawable area. */
export function isCanvasCollapsed(canvas) {
  if (!canvas) return true;
  const width = canvas.clientWidth ?? canvas.width ?? 0;
  const height = canvas.clientHeight ?? canvas.height ?? 0;
  return !(width > 0 && height > 0);
}

/**
 * Attach recovery to a viewer. Returns a detach function.
 *
 * @param {object} viewer Cesium.Viewer-like object
 * @param {object} [options]
 */
export function installRenderRecovery(
  viewer,
  {
    windowRef = globalThis.window,
    now = () => Date.now(),
    maxRecoveries = DEFAULT_MAX_RECOVERIES,
    windowMs = DEFAULT_RECOVERY_WINDOW_MS,
    pollMs = DEFAULT_POLL_MS,
    logger = globalThis.console,
  } = {},
) {
  const scene = viewer?.scene;
  if (!scene?.renderError?.addEventListener || !windowRef) return () => {};

  // Cesium shows a modal error panel by default; a recoverable blip should
  // not pop a dialog over the console.
  try {
    viewer.scene.showRenderLoopErrors = false;
  } catch {
    /* read-only in some builds */
  }

  let recoveries = [];
  let pollTimer = null;
  let active = true;

  const stopPolling = () => {
    if (pollTimer !== null) windowRef.clearInterval(pollTimer);
    pollTimer = null;
  };

  const restart = () => {
    stopPolling();
    if (!active || viewer.isDestroyed?.()) return;
    try {
      viewer.resize?.();
      viewer.useDefaultRenderLoop = true;
      scene.requestRender?.();
      logger?.info?.(
        "[God's Eye View] render loop recovered after canvas resize",
      );
    } catch (error) {
      logger?.error?.("[God's Eye View] render recovery failed:", error);
    }
  };

  const onError = (_scene, error) => {
    if (!active) return;
    const canvas = viewer.canvas ?? scene.canvas;
    if (!isCanvasCollapsed(canvas)) {
      logger?.error?.(
        "[God's Eye View] render error (not recoverable):",
        error,
      );
      return;
    }
    const t = now();
    recoveries = recoveries.filter((at) => t - at < windowMs);
    if (recoveries.length >= maxRecoveries) {
      logger?.error?.(
        "[God's Eye View] render error repeated too often; leaving loop stopped",
        error,
      );
      return;
    }
    recoveries.push(t);
    stopPolling();
    pollTimer = windowRef.setInterval(() => {
      if (!active || viewer.isDestroyed?.()) return stopPolling();
      if (!isCanvasCollapsed(viewer.canvas ?? scene.canvas)) restart();
    }, pollMs);
  };

  const remove = scene.renderError.addEventListener(onError);
  return () => {
    active = false;
    stopPolling();
    remove?.();
  };
}
