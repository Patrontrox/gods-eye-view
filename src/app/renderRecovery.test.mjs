// RENDER RECOVERY — a transient 0×0 canvas must not freeze the globe forever,
// while real render errors on a sized canvas stay stopped and bounded.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { installRenderRecovery, isCanvasCollapsed } from './renderRecovery.js';

function harness({ width = 0, height = 0 } = {}) {
  const listeners = [];
  const timers = new Map();
  let nextId = 1;
  const canvas = { clientWidth: width, clientHeight: height };
  const viewer = {
    canvas,
    useDefaultRenderLoop: false,
    resized: 0,
    resize() {
      this.resized += 1;
    },
    isDestroyed: () => false,
    scene: {
      showRenderLoopErrors: true,
      renderError: {
        addEventListener(fn) {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
      requestRender() {},
    },
  };
  const windowRef = {
    setInterval(fn) {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
  };
  const tick = () => [...timers.values()].forEach((fn) => fn());
  const fire = () =>
    listeners.forEach((fn) => fn(viewer.scene, new Error('fbo')));
  const logger = { info() {}, error() {} };
  return { viewer, canvas, windowRef, tick, fire, timers, logger, listeners };
}

test('collapsed canvas detection', () => {
  assert.equal(isCanvasCollapsed(null), true);
  assert.equal(isCanvasCollapsed({ clientWidth: 0, clientHeight: 10 }), true);
  assert.equal(isCanvasCollapsed({ clientWidth: 5, clientHeight: 10 }), false);
});

test('restarts the loop once a collapsed canvas regains size', () => {
  const h = harness();
  installRenderRecovery(h.viewer, { windowRef: h.windowRef, logger: h.logger });
  assert.equal(h.viewer.scene.showRenderLoopErrors, false);
  h.fire();
  h.tick();
  assert.equal(h.viewer.useDefaultRenderLoop, false, 'still collapsed');
  h.canvas.clientWidth = 800;
  h.canvas.clientHeight = 600;
  h.tick();
  assert.equal(h.viewer.useDefaultRenderLoop, true);
  assert.equal(h.viewer.resized, 1);
  assert.equal(h.timers.size, 0);
});

test('errors on a sized canvas are not auto-restarted', () => {
  const h = harness({ width: 800, height: 600 });
  installRenderRecovery(h.viewer, { windowRef: h.windowRef, logger: h.logger });
  h.fire();
  assert.equal(h.timers.size, 0);
  assert.equal(h.viewer.useDefaultRenderLoop, false);
});

test('recoveries are bounded within the window', () => {
  const h = harness();
  let t = 0;
  installRenderRecovery(h.viewer, {
    windowRef: h.windowRef,
    logger: h.logger,
    maxRecoveries: 2,
    now: () => t,
  });
  for (let i = 0; i < 3; i += 1) {
    h.viewer.useDefaultRenderLoop = false;
    h.canvas.clientWidth = 0;
    h.fire();
    h.canvas.clientWidth = 10;
    h.canvas.clientHeight = 10;
    h.tick();
    t += 1;
  }
  assert.equal(
    h.viewer.useDefaultRenderLoop,
    false,
    'third failure stays stopped',
  );
});

test('detach removes the listener and timers', () => {
  const h = harness();
  const detach = installRenderRecovery(h.viewer, {
    windowRef: h.windowRef,
    logger: h.logger,
  });
  h.fire();
  detach();
  assert.equal(h.listeners.length, 0);
  assert.equal(h.timers.size, 0);
});
