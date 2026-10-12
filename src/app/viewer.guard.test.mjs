import test from 'node:test';
import assert from 'node:assert/strict';
import { installNonZeroCanvasRenderGuard } from './viewer.js';

test('zero-size canvas suppresses a frame; normal canvas resumes', () => {
  const canvas = { clientWidth: 100, clientHeight: 100, width: 100, height: 100 };
  let draws = 0;
  const scene = { render() { draws++; } };
  const original = scene.render;
  const dispose = installNonZeroCanvasRenderGuard({ scene, canvas });
  scene.render();
  assert.equal(draws, 1);
  for (const dimension of ['clientWidth', 'clientHeight', 'width', 'height']) {
    canvas[dimension] = 0;
    scene.render();
    assert.equal(draws, 1);
    canvas[dimension] = 100;
  }
  scene.render();
  assert.equal(draws, 2);
  dispose();
  assert.equal(scene.render, original);
});
