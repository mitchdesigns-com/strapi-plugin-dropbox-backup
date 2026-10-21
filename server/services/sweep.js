'use strict';

const fs = require('fs');
const path = require('path');

const { LOG, filePrefix, getConfig } = require('../utils');

module.exports = ({ strapi }) => ({
  /**
   * Deletes staging files left behind by a run that never finished.
   *
   * The runner unlinks its scratch files in a `finally`, which covers a failed
   * backup but not a killed process - and a backup is exactly when the process
   * is most likely to be killed, because the transfer engine leaks memory on
   * remote assets and PM2 restarts the app at max_memory_restart. Without this,
   * every interrupted run strands a multi-hundred-megabyte archive and the disk
   * fills, which is the condition the preflight check exists to avoid.
   *
   * Called at bootstrap, when by definition no run of this process is in
   * flight, so anything matching the prefix is stale. The single-fork PM2 setup
   * means no sibling process can own these files either; that assumption is
   * recorded in the plugin README alongside the concurrency guard.
   */
  async stale({ tmpDir }) {
    const prefix = filePrefix(getConfig(strapi));

    let entries;
    try {
      entries = await fs.promises.readdir(tmpDir);
    } catch (err) {
      // No staging directory yet is the normal state before the first run.
      if (err.code !== 'ENOENT') {
        strapi.log.warn(`${LOG} could not read ${tmpDir}: ${err.message}`);
      }
      return { removed: [], bytes: 0 };
    }

    const removed = [];
    let bytes = 0;

    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;

      const filePath = path.join(tmpDir, name);
      try {
        const { size } = await fs.promises.stat(filePath);
        await fs.promises.rm(filePath, { force: true });
        removed.push(name);
        bytes += size;
      } catch (err) {
        strapi.log.warn(`${LOG} could not remove stale ${name}: ${err.message}`);
      }
    }

    if (removed.length > 0) {
      strapi.log.warn(
        `${LOG} removed ${removed.length} stale staging file(s) freeing ` +
          `${Math.round(bytes / 1048576)} MB - a previous run did not finish: ${removed.join(', ')}`
      );
    }

    return { removed, bytes };
  },
});
