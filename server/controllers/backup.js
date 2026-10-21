'use strict';

const { getConfig, isConfigured } = require('../utils');

module.exports = ({ strapi }) => ({
  // A full run takes minutes and nginx's default proxy_read_timeout is 60s, so
  // this answers 202 immediately and the admin page polls /status. The promise
  // is deliberately discarded: runner.run() never rejects (it records failures
  // in the run log instead), and an unhandled rejection here would take the
  // whole process down on Node 22.
  run(ctx) {
    const config = getConfig(strapi);

    if (!isConfigured(config)) {
      return ctx.badRequest(
        'Dropbox is not configured. Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and ' +
          'DROPBOX_REFRESH_TOKEN in the server .env, then restart.'
      );
    }

    const runner = strapi.plugin('dropbox-backup').service('runner');

    if (runner.isRunning()) {
      ctx.status = 409;
      ctx.body = { started: false, running: true };
      return undefined;
    }

    // Opt-in per request: the media run is the ninety-minute one, so it is
    // never what a bare click means.
    const includeMedia = ctx.request.body?.includeMedia === true;

    void runner.run({ trigger: 'manual', by: ctx.state.user?.email, includeMedia });

    ctx.status = 202;
    ctx.body = { started: true, running: true, includeMedia };
    return undefined;
  },

  async status(ctx) {
    const config = getConfig(strapi);
    const runner = strapi.plugin('dropbox-backup').service('runner');

    ctx.body = {
      configured: isConfigured(config),
      running: runner.isRunning(),
      folder: config.folder,
      schedule: config.schedule,
      mediaSchedule: config.mediaSchedule,
      keep: config.keep,
      mediaKeep: config.mediaKeep,
      sqlDump: config.includeSqlDump,
      runs: await runner.history(),
    };
  },
});
