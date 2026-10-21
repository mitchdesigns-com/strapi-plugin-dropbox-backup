'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const { LOG } = require('../utils');

// MySQL option-file values are quoted, and the quoted form understands a small
// set of escapes. Only the backslash and the quote itself need escaping here.
const quoteOptionValue = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const probe = (bin, args = ['--version']) =>
  new Promise((resolve) => {
    const child = spawn(bin, args);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });

// Runs `bin` and gzips its stdout straight to disk, so a multi-gigabyte dump
// never lands uncompressed and never passes through memory.
const dumpToGzip = async ({ bin, args, env, destination }) => {
  const child = spawn(bin, args, { env: { ...process.env, ...env } });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${bin} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    );
  });

  await Promise.all([
    pipeline(
      child.stdout,
      zlib.createGzip({ level: 6 }),
      // Owner-only: this is the whole database, admin password hashes included.
      fs.createWriteStream(destination, { mode: 0o600 })
    ),
    exited,
  ]);

  return stderr;
};

module.exports = ({ strapi }) => ({
  /**
   * The raw-database half of a run: the only artifact that carries admin users,
   * admin roles and API tokens, which the transfer engine strips out of the
   * strapi-export archive on both export and import.
   *
   * Never throws for a missing dump tool — a backup without the SQL half is far
   * better than no backup, so this returns `{ skipped, reason }` and the runner
   * records it as a warning.
   */
  async create({ basePath }) {
    // getInfo() reports the dialect Strapi configured ('sqlite' | 'mysql' |
    // 'postgres'). The knex-level client name would be 'better-sqlite3' or
    // 'mysql2' instead, which is not what we want to branch on.
    const { client } = strapi.db.getInfo();
    const connection = strapi.db.config.connection.connection ?? {};

    if (client === 'sqlite') {
      const destination = `${basePath}.db.gz`;

      // VACUUM INTO creates the file itself, so its mode is whatever the umask
      // allows - typically world-readable. Putting it inside a 0700 directory
      // makes it unreachable by other users on the box regardless.
      const scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'strapi-backup-'));
      const snapshot = path.join(scratchDir, 'snapshot.db');

      try {
        // VACUUM INTO writes a consistent snapshot of a live database without
        // locking out readers. knex routes it to statement.run() because it is
        // not a reader, and raw() is not inside a transaction, which VACUUM
        // would refuse.
        await strapi.db.connection.raw('VACUUM INTO ?', [snapshot]);
        await pipeline(
          fs.createReadStream(snapshot),
          zlib.createGzip({ level: 6 }),
          fs.createWriteStream(destination, { mode: 0o600 })
        );
      } finally {
        await fs.promises.rm(scratchDir, { recursive: true, force: true });
      }

      const { size } = await fs.promises.stat(destination);
      return { path: destination, bytes: size, skipped: false };
    }

    if (client === 'mysql') {
      const version = await probe('mysqldump');

      if (!version) {
        return {
          skipped: true,
          reason: 'mysqldump is not on PATH — the SQL dump half of this backup was skipped',
        };
      }

      // CloudPanel ships either Oracle MySQL or MariaDB, and the two clients
      // disagree about these flags: MariaDB's mysqldump rejects both outright.
      // --set-gtid-purged=OFF keeps a GTID-enabled server from emitting a
      // SET @@GLOBAL.GTID_PURGED that breaks restoring onto a different server,
      // and --no-tablespaces avoids needing the PROCESS privilege, which a
      // panel-created database user generally does not have.
      const isMariaDb = /mariadb/i.test(version);

      const destination = `${basePath}.sql.gz`;
      const scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'strapi-backup-'));
      const optionsFile = path.join(scratchDir, 'mysqldump.cnf');

      // The password must never reach argv: `ps` is readable by every user on
      // the box. An option file is the documented way - written 0600 inside a
      // 0700 directory, so the credentials are unreadable even for the instant
      // the file exists.
      const lines = ['[mysqldump]'];
      if (connection.user) lines.push(`user=${quoteOptionValue(connection.user)}`);
      if (connection.password) lines.push(`password=${quoteOptionValue(connection.password)}`);
      if (connection.host) lines.push(`host=${quoteOptionValue(connection.host)}`);
      if (connection.port) lines.push(`port=${connection.port}`);
      if (connection.ssl) lines.push(isMariaDb ? 'ssl' : 'ssl-mode=REQUIRED');

      await fs.promises.writeFile(optionsFile, `${lines.join('\n')}\n`, { mode: 0o600 });

      try {
        const args = [
          // Has to be the first argument or mysqldump ignores it.
          `--defaults-extra-file=${optionsFile}`,
          '--single-transaction',
          '--quick',
          '--routines',
          '--default-character-set=utf8mb4',
          ...(isMariaDb ? [] : ['--no-tablespaces', '--set-gtid-purged=OFF']),
          connection.database,
        ];

        const stderr = await dumpToGzip({ bin: 'mysqldump', args, destination });
        if (stderr.trim()) strapi.log.warn(`${LOG} mysqldump: ${stderr.trim()}`);
      } finally {
        await fs.promises.rm(scratchDir, { recursive: true, force: true });
      }

      const { size } = await fs.promises.stat(destination);
      return { path: destination, bytes: size, skipped: false };
    }

    if (client === 'postgres') {
      const version = await probe('pg_dump');

      if (!version) {
        return {
          skipped: true,
          reason: 'pg_dump is not on PATH — the SQL dump half of this backup was skipped',
        };
      }

      const destination = `${basePath}.sql.gz`;
      const args = ['--no-owner', '--no-privileges'];
      if (connection.host) args.push('--host', connection.host);
      if (connection.port) args.push('--port', String(connection.port));
      if (connection.user) args.push('--username', connection.user);
      args.push(connection.database);

      // PGPASSWORD is scoped to this child process; argv stays clean.
      await dumpToGzip({
        bin: 'pg_dump',
        args,
        env: connection.password ? { PGPASSWORD: connection.password } : {},
        destination,
      });

      const { size } = await fs.promises.stat(destination);
      return { path: destination, bytes: size, skipped: false };
    }

    return { skipped: true, reason: `no SQL dump strategy for database client "${client}"` };
  },
});
