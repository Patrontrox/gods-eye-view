/** Motion-aware optional work scheduler: no viewport changes should trigger stale UI commits.
 * It NEVER schedules essential safety/provenance updates; consumers choose optional refinements.
 */
export function createRefinementScheduler({quietMs = 180,
  schedule = (fn,ms) => setTimeout(fn,ms), cancel = (id) => clearTimeout(id) } = {}) {
  if (!Number.isInteger(quietMs) || quietMs < 0 || quietMs > 5000) throw new RangeError('quietMs 0..5000');
  let generation = 0, moving = false, disposed = false, pending = null, timer = null;
  const clear = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const flush = () => { timer = null; if (disposed || moving || !pending) return;
    const fn = pending; pending = null; const runGeneration = generation;
    void Promise.resolve().then(() => fn({ generation: runGeneration,
      current: () => !disposed && !moving && generation === runGeneration })).catch(()=>{});
  };
  return Object.freeze({
    motionStart() { if (disposed) return; generation++; moving = true; clear(); },
    motionStop() { if (disposed) return; moving = false; clear(); timer = schedule(flush,quietMs); },
    request(task) { if (disposed) return false; if (typeof task !== 'function') throw new TypeError('Task callback required');
      pending = task; if (!moving) { clear(); timer = schedule(flush,quietMs); } return true; },
    diagnostics() { return { generation, moving, pending: Boolean(pending), disposed }; },
    dispose() { disposed = true; generation++; clear(); pending = null; },
  });
}
