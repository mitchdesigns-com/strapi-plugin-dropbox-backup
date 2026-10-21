'use strict';

const fs = require('fs');
const path = require('path');

const {
  LOG,
  filePrefix,
  folderFor,
  getConfig,
  normalizeFolder,
  resolveTmpDir,
  timestamp,
} = require('../utils');

const HISTORY_KEY = 'runs';
const HISTORY_LIMIT = 20;

// PM2 runs this app as a single fork (ecosystem.config.js), so one module-level
// guard is enough to keep the cron job and the admin button from overlapping.
// Were that ever changed to cluster mode, each fork would schedule its own job
// and this guard would no longer span them.
let running = null;

module.exports = ({ strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: 'dropbox-backup' });

  const history = async () => (await store().get({ key: HISTORY_KEY })) ?? [];

  const record = async (entry) => {
    const runs = [entry, ...(await history())].slice(0, HISTORY_LIMIT);
    await store().set({ key: HISTORY_KEY, value: runs });
  };

  const doRun = async ({ trigger, by, includeMedia }) => {
    const config = getConfig(strapi);
    const plugin = strapi.plugin('dropbox-backup');
    const startedAt = new Date();
    const stamp = timestamp(startedAt);

    const warnings = [];
    const artifacts = [];
    const localFiles = [];

    const kind = includeMedia ? 'database + media mirror' : 'database only';
    strapi.log.info(
      `${LOG} run ${stamp} started, ${kind} (${trigger}${by ? ` by ${by}` : ''})`
    );

    try {
      const tmpDir = resolveTmpDir(strapi, config.tmpDir);
      await plugin
        .service('preflight')
        .check({ tmpDir, minFreeBytes: config.minFreeMb * 1024 * 1024, includeMedia });

      const basePath = path.join(tmpDir, `${filePrefix(config)}${stamp}`);

      // The archive is always database-only now. Media is mirrored as
      // individual objects instead of being embedded here, so a killed run
      // costs one file rather than a multi-gigabyte tar, and a second pass
      // uploads only what is missing.
      const archive = await plugin.service('archive').create({
        basePath,
        encryptionKey: config.encryptionKey,
        includeMedia: false,
      });
      localFiles.push(archive.path);
      warnings.push(...archive.warnings);
      strapi.log.info(`${LOG} archive written (${archive.bytes} bytes)`);

      if (config.includeSqlDump) {
        const dump = await plugin.service('sqldump').create({ basePath });
        if (dump.skipped) {
          warnings.push(dump.reason);
          strapi.log.warn(`${LOG} ${dump.reason}`);
        } else {
          localFiles.push(dump.path);
          strapi.log.info(`${LOG} SQL dump written (${dump.bytes} bytes)`);
        }
      }

      const dropbox = plugin.service('dropbox');
      const baseFolder = normalizeFolder(config.folder);
      const folder = folderFor(baseFolder, false);
      await dropbox.ensureFolder(folder);

      for (const localPath of localFiles) {
        const name = path.basename(localPath);
        const uploaded = await dropbox.uploadFile({
          localPath,
          dropboxPath: `${folder}/${name}`,
          chunkSize: config.chunkSize,
        });
        artifacts.push({ name, bytes: uploaded.bytes });
        strapi.log.info(`${LOG} uploaded ${name} (${uploaded.bytes} bytes)`);
      }

      const { prunedRuns } = await plugin
        .service('retention')
        .prune({ keep: config.keep, folder });

      // Runs after the archive so a media failure can never cost us the
      // database backup, which is the one with a hard freshness requirement.
      let media = null;
      if (includeMedia) {
        media = await plugin.service('media').sync({
          folder: baseFolder,
          chunkSize: config.chunkSize,
          tmpDir,
          maxDurationMs: config.mediaMaxMinutes * 60 * 1000,
        });
        warnings.push(
          ...(media.failed > 0 ? [`${media.failed} media object(s) failed to mirror`] : []),
          ...(media.timedOut ? ['media mirror hit its time budget and will resume next run'] : [])
        );
      }

      const entry = {
        stamp,
        at: startedAt.toISOString(),
        trigger,
        by: by ?? null,
        includeMedia,
        media,
        ok: true,
        durationMs: Date.now() - startedAt.getTime(),
        artifacts,
        prunedRuns,
        warnings,
        error: null,
      };

      await record(entry);
      strapi.log.info(`${LOG} run ${stamp} finished in ${entry.durationMs}ms`);

      return entry;
    } catch (err) {
      // Deliberately swallowed. The HTTP trigger discards this promise, and an
      // unhandled rejection is fatal on Node 22 — it would take the whole
      // process down over a failed backup. The failure is reported through the
      // log and the run history instead.
      strapi.log.error(`${LOG} run ${stamp} failed: ${err.message}`);

      const entry = {
        stamp,
        at: startedAt.toISOString(),
        trigger,
        by: by ?? null,
        includeMedia,
        ok: false,
        durationMs: Date.now() - startedAt.getTime(),
        artifacts,
        prunedRuns: 0,
        warnings,
        error: err.message,
      };

      await record(entry).catch((storeErr) =>
        strapi.log.error(`${LOG} could not record the failed run: ${storeErr.message}`)
      );

      return entry;
    } finally {
      // The local copies are scratch space; Dropbox holds the backup.
      for (const localPath of localFiles) {
        await fs.promises.rm(localPath, { force: true }).catch(() => {});
      }
    }
  };

  return {
    isRunning: () => running !== null,

    history,

    // Never rejects: doRun resolves with the run record either way.
    run({ trigger, by, includeMedia = false } = {}) {
      if (running) return running;
      running = doRun({ trigger: trigger ?? 'manual', by, includeMedia }).finally(() => {
        running = null;
      });
      return running;
    },
  };
};
