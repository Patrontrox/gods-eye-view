import { sameSiteGated } from './common/same-site.js';
import {
  governorSnapshot,
  installUpstreamGovernor,
} from './common/upstream-governor.js';

/**
 * Install the shared upstream governor for this server process and expose its
 * telemetry at `/api/governor/status` (same-site only, never cached).
 */
export function upstreamGovernorPlugin({ env = process.env } = {}) {
  const install = (server) => {
    installUpstreamGovernor(env);
    server.middlewares.use(
      '/api/governor/status',
      sameSiteGated((req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET');
          return res.end();
        }
        const snapshot = governorSnapshot();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(snapshot ?? { disabled: true }));
      }),
    );
  };
  return {
    name: 'upstream-governor',
    configureServer: install,
    configurePreviewServer: install,
  };
}
