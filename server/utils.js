'use strict';

const path = require('path');

const PLUGIN_ID = 'dropbox-backup';
const CRON_JOB_NAME = 'dropbox-backup';
const LOG = '[dropbox-backup]';

// Prefix shared by both artifacts of a run, and by the scratch files staged for
// it. The stamp is compact ISO8601 in UTC so a lexicographic sort of the Dropbox
// listing is also a chronological one.
//
// It is configurable because retention and the stale sweep match on it: one
// Dropbox app can hold several sites, and a site that changes its prefix stops
// pruning the files it wrote under the old one. Set it once and leave it.
const DEFAULT_FILE_PREFIX = 'strapi-backup-';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const filePrefix = (config) => {
  const configured = String(config?.filePrefix ?? '').trim();
  return configured || DEFAULT_FILE_PREFIX;
};

// Built per call rather than once at module scope: a RegExp carries no state
// here (no /g), but the prefix is only known once config is read.
const stampPattern = (prefix) => new RegExp(`^${escapeRegExp(prefix)}(\\d{8}T\\d{6}Z)\\.`);

const getConfig = (strapi) => strapi.config.get(`plugin::${PLUGIN_ID}`);

// Dropbox addresses the root of an app folder as an empty string - "/" is a
// malformed path to it - and a trailing slash would double up the separator in
// every child path. Normalising once here means "", "/", "/backups" and
// "/backups/" all behave, and a dedicated app can simply target its own root.
const normalizeFolder = (folder) => {
  const trimmed = String(folder ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const isConfigured = (config) =>
  Boolean(config && config.appKey && config.appSecret && config.refreshToken);

const timestamp = (date = new Date()) =>
  `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;

// Relative tmpDir values resolve against the app root rather than cwd, so the
// path is the same whether Strapi was started by pnpm, by PM2 or from a script.
const resolveTmpDir = (strapi, tmpDir) =>
  path.isAbsolute(tmpDir) ? tmpDir : path.join(strapi.dirs.app.root, tmpDir);

// Daily and weekly archives are kept apart so retention can prune each on its
// own count. Mixing them in one folder would let fourteen nightly runs evict
// every weekly media archive.
const SUBFOLDER = { daily: 'daily', weekly: 'weekly' };

const folderFor = (baseFolder, includeMedia) =>
  `${baseFolder}/${includeMedia ? SUBFOLDER.weekly : SUBFOLDER.daily}`;

module.exports = {
  PLUGIN_ID,
  folderFor,
  CRON_JOB_NAME,
  LOG,
  DEFAULT_FILE_PREFIX,
  filePrefix,
  stampPattern,
  getConfig,
  normalizeFolder,
  isConfigured,
  timestamp,
  resolveTmpDir,
};
