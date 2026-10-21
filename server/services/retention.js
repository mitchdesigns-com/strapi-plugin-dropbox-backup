'use strict';

const { LOG, filePrefix, getConfig, stampPattern } = require('../utils');

module.exports = ({ strapi }) => ({
  /**
   * Keeps the newest `keep` runs and deletes everything older.
   *
   * Pruning is by run, not by file: a run is a pair (the archive plus the SQL
   * dump), so "keep the newest N files" would really keep N/2 runs and could
   * leave one half of a pair behind without the other.
   */
  async prune({ keep, folder }) {
    const dropbox = strapi.plugin('dropbox-backup').service('dropbox');
    const entries = await dropbox.listFolder(folder);

    // Only this site's own files. A shared Dropbox app holds a folder per site,
    // and matching on the prefix as well as the folder means a misconfigured
    // folder cannot prune another site's backups.
    const pattern = stampPattern(filePrefix(getConfig(strapi)));

    const byStamp = new Map();

    for (const entry of entries) {
      if (entry['.tag'] !== 'file') continue;
      const match = pattern.exec(entry.name);
      if (!match) continue;

      const stamp = match[1];
      if (!byStamp.has(stamp)) byStamp.set(stamp, []);
      // path_lower is what delete_v2 wants, and it is present on every file entry.
      byStamp.get(stamp).push(entry.path_lower);
    }

    // The stamp is compact ISO8601 in UTC, so sorting the strings descending
    // sorts the runs newest-first.
    const stamps = [...byStamp.keys()].sort().reverse();
    const expired = stamps.slice(keep);

    if (expired.length === 0) {
      strapi.log.debug(`${LOG} retention: ${stamps.length} run(s) kept, nothing to prune`);
      return { kept: stamps.length, prunedRuns: 0, prunedFiles: [] };
    }

    const prunedFiles = [];

    for (const stamp of expired) {
      for (const filePath of byStamp.get(stamp)) {
        // A failure here must not fail the run: the backup is already safely
        // uploaded, and the next run will try the same deletion again.
        try {
          await dropbox.deleteFile(filePath);
          prunedFiles.push(filePath);
        } catch (err) {
          strapi.log.warn(`${LOG} could not prune ${filePath}: ${err.message}`);
        }
      }
    }

    strapi.log.info(`${LOG} pruned ${expired.length} expired run(s), kept ${keep}`);

    return { kept: Math.min(stamps.length, keep), prunedRuns: expired.length, prunedFiles };
  },
});
