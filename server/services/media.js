'use strict';

const fs = require('fs');
const path = require('path');

const { LOG } = require('../utils');

// Anything larger goes through a chunked upload session via a temp file rather
// than a single request. Dropbox caps files/upload around 150 MB, and holding a
// file this size in memory is already more than a backup should ask for.
const SINGLE_SHOT_LIMIT = 100 * 1024 * 1024;

/**
 * Every object a file row represents: the original plus each generated format.
 * Keyed by the hash, which is what makes the mirror addressable and lets a
 * second run recognise what it already uploaded.
 */
const objectsForFile = (file) => {
  const objects = [{ name: `${file.hash}${file.ext}`, url: file.url }];

  // formats is a JSON column; MySQL hands it back parsed, SQLite as a string.
  let formats = file.formats;
  if (typeof formats === 'string') {
    try {
      formats = JSON.parse(formats);
    } catch {
      formats = null;
    }
  }

  if (formats && typeof formats === 'object') {
    for (const format of Object.values(formats)) {
      if (format?.hash && format?.ext) {
        objects.push({ name: `${format.hash}${format.ext}`, url: format.url });
      }
    }
  }

  return objects;
};

module.exports = ({ strapi }) => {
  const dropbox = () => strapi.plugin('dropbox-backup').service('dropbox');

  /**
   * Mirrors the media library into Dropbox as individual objects, uploading
   * only what is not already there.
   *
   * Deliberately append-only. Syncing deletions would mean that deleting images
   * in Strapi also destroys the copy you would want to restore them from, which
   * defeats the entire point - R2 has no versioning and Cloudflare cannot
   * recover a deleted object, so this mirror is the only route back. Orphans
   * cost storage, and storage is the thing we have plenty of.
   *
   * Resumable by construction: state lives in the Dropbox listing rather than a
   * manifest that could drift, so an interrupted run simply resumes, and a
   * killed process loses one file instead of a whole archive.
   */
  async function sync({ folder, chunkSize, tmpDir, maxDurationMs = 0 }) {
    const startedAt = Date.now();
    const mediaFolder = `${folder}/media`;

    await dropbox().ensureFolder(mediaFolder);

    const existing = new Set(
      (await dropbox().listFolder(mediaFolder))
        .filter((entry) => entry['.tag'] === 'file')
        .map((entry) => entry.name)
    );

    strapi.log.info(`${LOG} media mirror: ${existing.size} object(s) already in ${mediaFolder}`);

    const result = { uploaded: 0, skipped: 0, failed: 0, bytes: 0, timedOut: false };
    const failures = [];

    const isLocalProvider = (file) => file.provider === 'local';

    const rows = strapi.db.queryBuilder('plugin::upload.file').select('*').stream();

    try {
      for await (const file of rows) {
        if (maxDurationMs > 0 && Date.now() - startedAt > maxDurationMs) {
          // Out of budget rather than broken: the next run continues from the
          // listing, so stopping here costs nothing already done.
          result.timedOut = true;
          break;
        }

        for (const object of objectsForFile(file)) {
          if (existing.has(object.name)) {
            result.skipped += 1;
            continue;
          }

          try {
            const bytes = await uploadOne({
              object,
              file,
              mediaFolder,
              chunkSize,
              tmpDir,
              local: isLocalProvider(file),
            });
            existing.add(object.name);
            result.uploaded += 1;
            result.bytes += bytes;
          } catch (err) {
            // One unreachable asset must not end the mirror - a library this
            // size reliably contains a few rows whose object is already gone.
            result.failed += 1;
            if (failures.length < 10) failures.push(`${object.name}: ${err.message}`);
          }
        }
      }
    } finally {
      // The knex stream holds a connection until it is drained or destroyed.
      rows.destroy?.();
    }

    if (result.failed > 0) {
      strapi.log.warn(
        `${LOG} media mirror: ${result.failed} object(s) failed, first few: ${failures.join(' | ')}`
      );
    }

    strapi.log.info(
      `${LOG} media mirror: uploaded ${result.uploaded}, skipped ${result.skipped}, ` +
        `failed ${result.failed}, ${Math.round(result.bytes / 1048576)} MB in ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s${result.timedOut ? ' (time budget reached)' : ''}`
    );

    return result;
  }

  async function uploadOne({ object, file, mediaFolder, chunkSize, tmpDir, local }) {
    const dropboxPath = `${mediaFolder}/${object.name}`;

    if (local) {
      const source = path.join(strapi.dirs.static.public, object.url);
      const { size } = await fs.promises.stat(source);
      await dropbox().uploadFile({ localPath: source, dropboxPath, chunkSize });
      return size;
    }

    const response = await strapi.fetch(object.url);
    if (!response.ok) {
      // Body is drained by arrayBuffer below only on the success path, so an
      // error response is cancelled explicitly to free the socket.
      await response.body?.cancel().catch(() => {});
      throw new Error(`fetch failed with ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length'));

    if (Number.isFinite(contentLength) && contentLength > SINGLE_SHOT_LIMIT) {
      // Too big to hold in memory: stage it and use the chunked session.
      const staged = path.join(tmpDir, `media-${process.pid}-${Date.now()}-${object.name}`);
      try {
        await fs.promises.writeFile(staged, response.body, { mode: 0o600 });
        const { size } = await fs.promises.stat(staged);
        await dropbox().uploadFile({ localPath: staged, dropboxPath, chunkSize });
        return size;
      } finally {
        await fs.promises.rm(staged, { force: true }).catch(() => {});
      }
    }

    const data = Buffer.from(await response.arrayBuffer());
    await dropbox().uploadData({ dropboxPath, data });
    return data.length;
  }

  return { sync };
};
