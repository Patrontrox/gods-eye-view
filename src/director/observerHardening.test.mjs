import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionSession } from './interactions/session.js';
import { createPlaybackClock } from './clock.js';
import { buildPlaybackQueue, playSceneQueue } from './playback.js';

test('throwing interaction observer cannot strand busy or abort cleanup', async () => {
  let runs = 0;
  const session = createInteractionSession({
    execute: async () => { runs++; return true; },
    changed: () => { throw new Error('UI callback failed'); },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    session.activate([{ id: 'one' }]);
    assert.equal(await session.dispatch('one'), true);
    assert.equal(session.getState().busy, false);
    assert.equal(await session.dispatch('one'), true);
    assert.equal(runs, 2);
  } finally { console.warn = originalWarn; }
});

test('throwing first clock observer does not prevent unsubscribe', () => {
  const clock = createPlaybackClock({
    isRunning: () => false,
    timingForShot: () => ({ shotIndex: 0, totalSec: 1 }),
    onProgress: () => {},
  });
  const scene = { id: 'test', shots: [{ id: 'first' }] };
  clock.publish(scene, scene.shots[0], 0);
  const previous = console.warn;
  console.warn = () => {};
  try {
    const remove = clock.subscribe(() => { throw new Error('UI failed'); });
    assert.equal(typeof remove, 'function');
    remove();
  } finally { console.warn = previous; clock.destroy(); }
});

test('cleanup failure does not hide primary phase failure', async () => {
  const primary = new Error('phase failure');
  const phases = ['selectShot','applyVisual','applyLayers','travel','settle','hold','completeShot'];
  const scene = { id: 'a', shots: [{ id: 'first' }] };
  const adapter = Object.fromEntries(phases.map((name) => [name, () => {
    if (name === 'selectShot') throw primary;
  }]));
  adapter.releaseScene = () => { throw new Error('cleanup failure'); };
  const previous = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      playSceneQueue(buildPlaybackQueue([scene], 'a'), {
        token: { cancelled: false }, adapter,
      }),
      (error) => error === primary,
    );
  } finally { console.warn = previous; }
});

test('an inter-scene release is not attempted twice if it fails', async () => {
  const phases = ['selectShot','applyVisual','applyLayers','travel','settle','hold','completeShot'];
  const scenes = [{ id: 'a', shots: [{ id: 'a1' }] }, { id: 'b', shots: [{ id: 'b1' }] }];
  let releases = 0;
  const adapter = Object.fromEntries(phases.map((phase) => [phase, () => {}]));
  adapter.releaseScene = () => { releases++; throw new Error('release failed'); };
  await assert.rejects(playSceneQueue(buildPlaybackQueue(scenes, 'a'), {
    token: { cancelled: false }, adapter,
  }), /release failed/);
  assert.equal(releases, 1);
});
