'use strict';

const {
  CRON_JOB_NAME,
  getConfig,
  isConfigured,
  normalizeFolder,
  resolveTmpDir,
} = require('./utils');

module.exports = ({ strapi }) => {
  const config = getConfig(strapi);

  // Clear anything a killed run left staged. Fire-and-forget: a sweep failure
  // must never stop the plugin from loading, and nothing below depends on it.
  strapi
    .plugin('dropbox-backup')
    .service('sweep')
    .stale({ tmpDir: resolveTmpDir(strapi, config.tmpDir) })
    .catch((err) => strapi.log.warn(`[dropbox-backup] stale sweep failed: ${err.message}`));

  if (!isConfigured(config)) {
    strapi.log.warn(
      '[dropbox-backup] no Dropbox credentials in .env — nothing is scheduled. ' +
        'Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN to enable backups.'
    );
    return;
  }

  // One Dropbox app can serve several sites, each in its own subfolder. An
  // empty folder points at the app folder root, which is correct only when the
  // app belongs to this site alone - otherwise two sites write into the same
  // place and each one's retention sees the other's files.
  if (!normalizeFolder(config.folder)) {
    strapi.log.warn(
      '[dropbox-backup] DROPBOX_BACKUP_FOLDER is empty - backups go to the root of the ' +
        'Dropbox app folder. Set it if this Dropbox app serves more than one site.'
    );
  }

  // server.cron.enabled gates only the tasks loaded from config files: the cron
  // provider calls start() unconditionally, so a job added here would run even
  // with cron switched off. Hence the explicit check.
  if (!strapi.config.get('server.cron.enabled', true)) {
    strapi.log.info('[dropbox-backup] server cron is disabled — on-demand backups only.');
    return;
  }

  const run = (includeMedia) => ({ strapi: s }) =>
    s.plugin('dropbox-backup').service('runner').run({ trigger: 'cron', includeMedia });

  // Two schedules. The nightly one skips the media binaries and takes a minute
  // or two; the weekly one includes ~11k files from R2 and takes about ninety,
  // with DB lifecycle hooks disabled throughout - which is exactly why it is
  // not run every night. The object form goes straight to node-schedule, which
  // would otherwise read the rule in the server's local timezone.
  const scheduled = [];

  if (config.schedule) {
    strapi.cron.add({
      [CRON_JOB_NAME]: {
        task: run(false),
        options: { rule: config.schedule, tz: config.timezone },
      },
    });
    scheduled.push(`database "${config.schedule}"`);
  }

  if (config.mediaSchedule) {
    strapi.cron.add({
      [`${CRON_JOB_NAME}-media`]: {
        task: run(true),
        options: { rule: config.mediaSchedule, tz: config.timezone },
      },
    });
    scheduled.push(`media "${config.mediaSchedule}"`);
  }

  if (scheduled.length === 0) {
    strapi.log.info('[dropbox-backup] no schedule configured — on-demand backups only.');
    return;
  }

  strapi.log.info(
    `[dropbox-backup] scheduled ${scheduled.join(', ')} ${config.timezone} -> ${config.folder}`
  );
};
