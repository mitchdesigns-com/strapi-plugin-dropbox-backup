'use strict';

const fs = require('fs');

const { LOG } = require('../utils');

// Both artifacts live in tmpDir at the same time, and gzip ratios on media are
// close to 1, so the estimate is deliberately pessimistic.
const SAFETY_FACTOR = 1.3;

module.exports = ({ strapi }) => {
  // Media is stored as decimal kilobytes in the upload table. Summing there
  // rather than walking the bucket also covers R2, where the binaries are not
  // on this disk but are downloaded into the archive as it is written.
  //
  // This undercounts: the engine also downloads every entry in a file's
  // `formats` (thumbnail, small, medium, large), which the `size` column does
  // not include. SAFETY_FACTOR and the configured floor absorb that.
  const mediaBytes = async () => {
    try {
      const { tableName } = strapi.db.metadata.get('plugin::upload.file');
      const [row] = await strapi.db.connection(tableName).sum({ kb: 'size' });
      return Math.round((Number(row?.kb) || 0) * 1024);
    } catch (err) {
      strapi.log.debug(`${LOG} could not size the media library: ${err.message}`);
      return null;
    }
  };

  const databaseBytes = async () => {
    const { client } = strapi.db.getInfo();
    const connection = strapi.db.config.connection.connection ?? {};

    try {
      if (client === 'sqlite') {
        const { size } = await fs.promises.stat(connection.filename);
        return size;
      }
      if (client === 'mysql') {
        const [rows] = await strapi.db.connection.raw(
          'SELECT SUM(data_length + index_length) AS bytes FROM information_schema.TABLES WHERE table_schema = DATABASE()'
        );
        return Number(rows?.[0]?.bytes) || null;
      }
      if (client === 'postgres') {
        const result = await strapi.db.connection.raw(
          'SELECT pg_database_size(current_database()) AS bytes'
        );
        return Number(result?.rows?.[0]?.bytes) || null;
      }
    } catch (err) {
      strapi.log.debug(`${LOG} could not size the database: ${err.message}`);
    }

    return null;
  };

  return {
    /**
     * Fails a run before it starts rather than part-way through.
     *
     * This matters more than it looks: the transfer engine's file destination
     * throws from inside the write stream's 'error' handler, which no caller can
     * catch, so a disk that fills mid-write takes the whole process down. The
     * cheapest defence is to not start when the space clearly is not there.
     */
    async check({ tmpDir, minFreeBytes, includeMedia = false }) {
      await fs.promises.mkdir(tmpDir, { recursive: true, mode: 0o700 });

      // mkdir's mode only applies to a directory it actually creates, so an
      // existing one is tightened explicitly. Everything staged here is a full
      // copy of the site's data, and the VPS is shared.
      await fs.promises.chmod(tmpDir, 0o700);

      // Surfaces a read-only or wrongly-owned directory as a recorded failure
      // instead of an uncatchable throw later on.
      await fs.promises.access(tmpDir, fs.constants.W_OK);

      // A database-only run never downloads the media, so counting it would
      // refuse runs that need a fraction of the space.
      const [media, database] = await Promise.all([
        includeMedia ? mediaBytes() : Promise.resolve(0),
        databaseBytes(),
      ]);

      // An unknown component falls back to the configured floor, so a failure to
      // measure never silently disables the check.
      const estimate =
        media === null || database === null
          ? minFreeBytes
          : Math.max(Math.round((media + database) * SAFETY_FACTOR), minFreeBytes);

      let freeBytes = null;
      try {
        const stats = await fs.promises.statfs(tmpDir);
        freeBytes = Number(stats.bavail) * Number(stats.bsize);
      } catch (err) {
        strapi.log.debug(`${LOG} could not read free disk space: ${err.message}`);
      }

      if (freeBytes !== null && freeBytes < estimate) {
        throw new Error(
          `not enough free disk space in ${tmpDir}: ${Math.round(freeBytes / 1048576)} MB free, ` +
            `about ${Math.round(estimate / 1048576)} MB needed`
        );
      }

      strapi.log.debug(
        `${LOG} preflight ok: need ~${Math.round(estimate / 1048576)} MB, ` +
          `${freeBytes === null ? 'unknown' : Math.round(freeBytes / 1048576)} MB free`
      );

      return { estimate, freeBytes };
    },
  };
};
