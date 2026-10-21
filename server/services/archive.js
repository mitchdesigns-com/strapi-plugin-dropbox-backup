'use strict';

const fs = require('fs');

const { file, strapi: strapiProviders, engine: transferEngine } = require('@strapi/data-transfer');
const { LOG } = require('../utils');

const { createLocalFileDestinationProvider } = file.providers;
const { createLocalStrapiSourceProvider } = strapiProviders.providers;
const { createTransferEngine } = transferEngine;

// The same filter `strapi import` applies, so the archive only carries what a
// restore would actually accept. Everything admin:: — admin users, admin roles,
// API tokens, transfer tokens — is dropped on both sides, which is exactly why
// services/sqldump.js exists alongside this.
const IGNORED_CONTENT_TYPE_PREFIXES = ['admin::'];
const IGNORED_CONTENT_TYPES = [
  'plugin::content-releases.release',
  'plugin::content-releases.release-action',
];

const isIncluded = (uid) =>
  !IGNORED_CONTENT_TYPE_PREFIXES.some((prefix) => uid.startsWith(prefix)) &&
  !IGNORED_CONTENT_TYPES.includes(uid);

const transforms = {
  entities: [{ filter: (entity) => isIncluded(entity.type) }],
  links: [{ filter: (link) => isIncluded(link.left.type) && isIncluded(link.right.type) }],
};

// Write failures the transfer engine raises in a way no caller can catch: its
// file destination attaches an 'error' listener to the output stream whose body
// is `throw err`, so the error surfaces as an uncaughtException rather than a
// rejected promise. These are the codes that listener can see.
const UNCATCHABLE_WRITE_CODES = new Set([
  'ENOSPC',
  'ENOTDIR',
  'EACCES',
  'EROFS',
  'EDQUOT',
  'EPERM',
  'EIO',
  'EMFILE',
]);

// The ENOSPC case is re-wrapped by the provider and loses err.code, so it has to
// be matched by name.
const isUncatchableWriteError = (err) =>
  UNCATCHABLE_WRITE_CODES.has(err?.code) || err?.name === 'ProviderTransferError';

// Works around a leak in the transfer engine's remote-asset path.
//
// local-source/assets.js calls getFileStatsForTransfer for every file AND every
// image format, which issues a full GET through strapi.fetch, reads only the
// content-length header, and then never consumes or cancels the body. Undici
// keeps each abandoned body's buffer and socket alive until GC, so on a media
// library served from R2 the process climbs steadily - on this box it reached
// PM2's max_memory_restart and the restart killed the backup nine minutes in,
// taking the CMS with it.
//
// The two call sites are distinguishable without guessing: getFileStream hands
// the body to stream.Readable.fromWeb synchronously, which locks it, while the
// stats call never touches it. So a body still unlocked and unused one tick
// after the response resolves is one nobody will ever read, and cancelling it
// releases the socket immediately.
const patchFetchToReleaseAbandonedBodies = (strapi) => {
  const original = strapi.fetch;

  if (typeof original !== 'function') return () => {};

  const patched = function patchedFetch(...args) {
    const result = original.apply(this, args);

    if (!result || typeof result.then !== 'function') return result;

    return result.then((response) => {
      setImmediate(() => {
        const body = response?.body;
        if (body && !response.bodyUsed && !body.locked) {
          body.cancel().catch(() => {});
        }
      });
      return response;
    });
  };

  // strapi.fetch is a prototype getter reading from the DI container, so it
  // cannot be assigned. An own property shadows it for the duration of the
  // transfer, and deleting that property restores the original getter without
  // touching the container.
  Object.defineProperty(strapi, 'fetch', {
    value: patched,
    configurable: true,
    writable: true,
    enumerable: false,
  });

  return () => {
    delete strapi.fetch;
  };
};

// Silences a deprecation warning the transfer engine triggers once per media
// file. signUploadFileForTransfer reads strapi.config.get('plugin.upload'), and
// the config provider warns on every single call with a 'plugin.' path - there
// is no dedup - before rewriting it to 'plugin::upload'. On a library of a few
// thousand assets that is a few thousand identical log lines per backup, which
// buries the lines that matter and costs real log I/O mid-run.
//
// Doing the same rewrite before the shim sees it resolves to exactly the same
// config value, minus the warning.
const patchConfigGetToNormalisePluginPaths = (strapi) => {
  const config = strapi.config;
  const originalGet = config?.get;

  if (typeof originalGet !== 'function') return () => {};

  try {
    config.get = function normalisedGet(path, defaultValue) {
      const normalised =
        typeof path === 'string' && path.startsWith('plugin.')
          ? `plugin::${path.slice('plugin.'.length)}`
          : path;
      return originalGet.call(this, normalised, defaultValue);
    };
  } catch {
    // Non-writable in some future version: the warning is cosmetic, so a
    // failure here must not stop the backup.
    return () => {};
  }

  return () => {
    config.get = originalGet;
  };
};

module.exports = ({ strapi }) => ({
  /**
   * Writes a strapi-export archive containing entities, links, the content-type
   * schemas and the core store - plus, when `includeMedia` is set, every media
   * binary fetched over HTTP from R2.
   *
   * `basePath` has no extension: the provider appends `.tar`, then `.gz`, then
   * `.enc`, so the real filename comes back in the return value.
   */
  async create({ basePath, encryptionKey, includeMedia = false }) {
    const source = createLocalStrapiSourceProvider({
      getStrapi: async () => strapi,
      // Defaults to true, and would call strapi.destroy() on this live
      // instance when the transfer finishes — i.e. shut the site down.
      autoDestroy: false,
    });

    const destination = createLocalFileDestinationProvider({
      file: { path: basePath },
      compression: { enabled: true },
      encryption: { enabled: Boolean(encryptionKey), key: encryptionKey || undefined },
    });

    const engine = createTransferEngine(source, destination, {
      versionStrategy: 'ignore',
      schemaStrategy: 'ignore',
      transforms,
      // The 'files' preset is the assets stage: the media binaries themselves.
      // Excluding it keeps every plugin::upload.file row — so the media library
      // metadata is still backed up — while skipping ~11k downloads from R2
      // that take about ninety minutes and hold DB lifecycle hooks disabled
      // throughout. The weekly run includes them.
      ...(includeMedia ? {} : { exclude: ['files'] }),
    });

    const warnings = [];

    // Surfaces missing-asset and schema warnings through the app log. The CLI's
    // own formatDiagnostic is deliberately not reused: it writes a log file
    // into the process cwd, which here is the deployed site directory.
    engine.diagnostics.onDiagnostic(({ kind, details }) => {
      if (kind === 'error') {
        const message = `${details.severity ?? 'error'}: ${details.message}`;
        warnings.push(message);
        strapi.log.error(`${LOG} ${message}`);
        return;
      }
      if (kind === 'warning') {
        warnings.push(details.message);
        strapi.log.warn(`${LOG} ${details.message}`);
      }
    });

    engine.progress.stream.on('stage::finish', ({ stage }) => {
      strapi.log.debug(`${LOG} archive stage done: ${stage}`);
    });

    // Turns that uncatchable throw into a normal rejection for the duration of
    // the transfer, so a full disk fails the backup instead of killing Strapi.
    // Anything that is not a write failure is re-thrown, which restores Node's
    // default behaviour for an unrelated bug rather than silently swallowing it.
    let onUncaught;
    const uncatchable = new Promise((_, reject) => {
      onUncaught = (err) => {
        if (!isUncatchableWriteError(err)) {
          process.removeListener('uncaughtException', onUncaught);
          throw err;
        }
        strapi.log.error(`${LOG} archive write failed: ${err.message}`);
        reject(err);
        // The engine is still streaming entities into a pipeline that has
        // already broken. Without this it keeps going, and its own error path
        // waits on a 'close' event the dead pipeline will never emit.
        engine.abortTransfer().catch(() => {});
      };
    });
    // Keeps a late write error — one arriving in the window between the transfer
    // resolving and the listener being removed — from becoming an unhandled
    // rejection, which would be fatal on its own. Promise.race still sees it.
    uncatchable.catch(() => {});
    process.on('uncaughtException', onUncaught);

    const restoreFetch = patchFetchToReleaseAbandonedBodies(strapi);
    const restoreConfigGet = patchConfigGetToNormalisePluginPaths(strapi);
    const rssAtStart = process.memoryUsage().rss;
    let peakRss = rssAtStart;
    const rssSampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 2000).unref();

    // Held in a variable, and given a no-op handler, because the race abandons
    // whichever side loses: a rejection from the transfer after `uncatchable`
    // has already won would otherwise be unhandled, and an unhandled rejection
    // is fatal - the very crash this whole dance exists to avoid.
    const transfer = engine.transfer();
    transfer.catch(() => {});

    let results;
    try {
      results = await Promise.race([transfer, uncatchable]);
    } finally {
      clearInterval(rssSampler);
      restoreConfigGet();
      restoreFetch();
      process.removeListener('uncaughtException', onUncaught);

      // Recorded so a run that dies to max_memory_restart leaves evidence of
      // how close it got, rather than just vanishing.
      strapi.log.info(
        `${LOG} memory during archive: ${Math.round(rssAtStart / 1048576)} MB -> ` +
          `peak ${Math.round(peakRss / 1048576)} MB`
      );

      // The source provider disables DB lifecycles in its bootstrap and only
      // re-enables them in close(), which the engine never calls on its error
      // path. Without this, one failed backup leaves every model lifecycle and
      // the timestamps subscriber off for the whole process until PM2 restarts
      // it. enable() is idempotent, so running it after a success is harmless.
      strapi.db.lifecycles.enable();
    }

    const archivePath = results.destination?.file?.path;

    if (!archivePath || !fs.existsSync(archivePath)) {
      throw new Error('transfer engine reported success but wrote no archive');
    }

    // The destination provider opens this itself, so the mode is the umask's
    // choice. The archive holds every entry and every media file; the enclosing
    // directory is already 0700, and this closes the gap if tmpDir is pointed
    // somewhere laxer.
    await fs.promises.chmod(archivePath, 0o600);

    const { size } = await fs.promises.stat(archivePath);

    return { path: archivePath, bytes: size, warnings };
  },
});
