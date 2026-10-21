'use strict';

// Every knob lives in the server's .env. The plugin is inert until the three
// Dropbox credentials are set — see the plugin README for how to mint them.
module.exports = {
  default: ({ env }) => ({
    appKey: env('DROPBOX_APP_KEY'),
    appSecret: env('DROPBOX_APP_SECRET'),
    refreshToken: env('DROPBOX_REFRESH_TOKEN'),

    // Path inside the Dropbox App folder (Apps/<app-name>/), never the account
    // root. One app can hold a subfolder per Strapi site, so this is the site's
    // own subfolder. Empty targets the app folder itself, which is only right
    // for an app dedicated to a single site - bootstrap warns when it is empty.
    folder: env('DROPBOX_BACKUP_FOLDER', ''),

    // Prefix on every file a run writes, locally and in Dropbox. Retention and
    // the stale sweep match on it, so changing it on a live site orphans the
    // backups written under the old prefix: they stop being pruned and the
    // keep count starts again from zero. Pick one per site and keep it.
    filePrefix: env('DROPBOX_BACKUP_PREFIX', 'strapi-backup-'),

    // How many runs to keep, per schedule. Daily and weekly live in separate
    // subfolders and are pruned independently — otherwise a fortnight of daily
    // runs would evict every weekly media archive.
    keep: env.int('DROPBOX_BACKUP_KEEP', 14),
    mediaKeep: env.int('DROPBOX_BACKUP_MEDIA_KEEP', 8),

    // Nightly: database, schemas and media metadata. Excludes the media
    // binaries, so it finishes in a minute or two rather than ~90.
    // Empty disables the schedule without disabling the plugin.
    schedule: env('DROPBOX_BACKUP_CRON', '0 30 3 * * *'),

    // Media mirror: individual objects under <folder>/media, uploaded only if
    // not already there. The first pass is long; every pass after it is short,
    // so this can safely run nightly. R2 has no object versioning and
    // Cloudflare cannot recover a deleted object, so this mirror is the only
    // thing standing between an accidental media deletion and permanent loss.
    mediaSchedule: env('DROPBOX_BACKUP_MEDIA_CRON', '0 0 4 * * *'),

    // Stop a mirror pass after this long and let the next one resume from the
    // Dropbox listing. 0 disables the budget. Keeps a nightly pass from running
    // into working hours on the first, very long, sync.
    mediaMaxMinutes: env.int('DROPBOX_BACKUP_MEDIA_MAX_MINUTES', 60),

    // node-schedule reads a bare rule in the server's local timezone, which on
    // the VPS is not UTC. Naming the zone explicitly keeps the slot where it was
    // meant to be across daylight-saving changes.
    timezone: env('DROPBOX_BACKUP_TZ', 'UTC'),

    // The raw SQL dump alongside the strapi-export archive. It is the only
    // artifact that carries admin users, admin roles and API tokens, which the
    // transfer engine filters out of the archive on both export and import.
    includeSqlDump: env.bool('DROPBOX_BACKUP_SQL_DUMP', true),

    // Optional. Unset means a plain .tar.gz; set it and restoring needs
    // `strapi import --key`. Note it encrypts only the archive, not the SQL dump.
    encryptionKey: env('DROPBOX_BACKUP_ENCRYPTION_KEY', undefined),

    // Dropbox requires every upload-session chunk except the last to be the
    // same size, and recommends a multiple of 4 MiB.
    chunkSize: env.int('DROPBOX_BACKUP_CHUNK_SIZE', 8 * 1024 * 1024),

    // Resolved against the app root, not cwd. Already gitignored.
    tmpDir: env('DROPBOX_BACKUP_TMP_DIR', '.tmp/backups'),

    // Floor for the pre-run free-space check, and the whole budget whenever the
    // media or database size cannot be measured. A run that would overflow the
    // disk is refused up front, because the transfer engine reports a write
    // failure in a way no caller can catch - see services/archive.js.
    minFreeMb: env.int('DROPBOX_BACKUP_MIN_FREE_MB', 1024),
  }),

  validator(config) {
    // Both artifacts of a run are named `<prefix><stamp>.<ext>`, and the stamp
    // is matched back out with a regex anchored on the prefix. A prefix ending
    // in a digit would let the pattern eat into it; one containing a slash or a
    // dot would change the Dropbox path or the extension split.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*[-_]$/.test(String(config.filePrefix ?? ''))) {
      throw new Error(
        'DROPBOX_BACKUP_PREFIX must be alphanumerics, dots, dashes or underscores, ' +
          'and must end in - or _ (e.g. "acme-backup-")'
      );
    }
    if (!Number.isInteger(config.keep) || config.keep < 1) {
      throw new Error('DROPBOX_BACKUP_KEEP must be an integer >= 1');
    }
    if (!Number.isInteger(config.chunkSize) || config.chunkSize % (4 * 1024 * 1024) !== 0) {
      throw new Error('DROPBOX_BACKUP_CHUNK_SIZE must be a multiple of 4194304 (4 MiB)');
    }
  },
};
