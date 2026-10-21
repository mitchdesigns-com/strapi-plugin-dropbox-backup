# strapi-plugin-dropbox-backup

Backs up a Strapi 5 instance to Dropbox — nightly by cron, and on demand from
**Admin → Dropbox backup**.

Built for several sites sharing one Dropbox app: each site gets its own folder
and its own filename prefix, and retention only ever touches files that match
both.

## Install

Any package manager — pnpm, npm or yarn. The plugin itself does not care which:
Strapi finds it by the `strapi.kind` field in its `package.json`.

```sh
# pnpm
pnpm add github:mitchdesigns-com/strapi-plugin-dropbox-backup#v0.1.2
pnpm add @strapi/data-transfer@$(node -p "require('@strapi/strapi/package.json').version")

# npm
npm install github:mitchdesigns-com/strapi-plugin-dropbox-backup#v0.1.2
npm install @strapi/data-transfer@$(node -p "require('@strapi/strapi/package.json').version")

# yarn 1
yarn add github:mitchdesigns-com/strapi-plugin-dropbox-backup#v0.1.2
yarn add @strapi/data-transfer@$(node -p "require('@strapi/strapi/package.json').version")
```

`@strapi/data-transfer` is the one requirement the host app has to provide: the
plugin builds the export archive with it, and it reaches into Strapi core
internals, so **its version must equal `@strapi/strapi`'s exactly** — hence
deriving it from the installed one rather than from a range. Skip that second
command when it is already a dependency at the right version. Forgetting it
fails loudly at boot with `Cannot find module '@strapi/data-transfer'`.

**The plugin declares no peer dependencies at all**, deliberately. A declared
peer - even an optional one - is something each package manager then tries to
reconcile against the app's tree, and they disagree about how: npm 7+ installs
non-optional peers at the newest in-range version (a 5.33 site would get
data-transfer 5.58, an internals mismatch that only shows up at 03:30), while a
range like `^2.0.0` refuses a prerelease, so a site on
`@strapi/design-system@2.0.0-rc.30` could not install the plugin at all. The
admin page's own imports (`@strapi/strapi/admin`, `@strapi/design-system`,
`react`) are resolved by Strapi's Vite aliases from whatever the app already
has, so declaring them bought nothing.

Strapi 5 auto-loads any dependency whose `package.json` carries
`strapi.kind: "plugin"`, so no `config/plugins.js` entry is required. Add one
only to set per-site configuration in code rather than in `.env`:

```js
// config/plugins.js
'dropbox-backup': {
  enabled: true,
  config: {
    folder: '/acme-cms',
    filePrefix: 'acme-backup-',
  },
},
```

Then mint the Dropbox credentials on the server (see **Dropbox setup**) and
restart. The plugin always loads but does nothing until the three credentials
are set: it schedules no cron job and its admin page says it is unconfigured.

Each site also needs:

- `mysqldump` (or `pg_dump`) on `PATH`, otherwise the SQL dump half is skipped
  with a warning and only the `.tar.gz` is uploaded
- `.tmp/` gitignored — `DROPBOX_BACKUP_TMP_DIR` defaults to `.tmp/backups`
- a process manager running **one** instance. The concurrency guard is
  in-process, so PM2 cluster mode would have every worker schedule its own
  backup.

### Upgrading a site that had the plugin vendored in `src/plugins/`

Set `filePrefix` to the prefix those backups already use (`alsson-backup-` for
Alsson). Retention matches on the prefix, so a new prefix orphans every existing
backup: they stop being pruned and the keep count restarts from zero.

## Configuration

Every knob is an env var, or a key under `config` in `config/plugins.js`.

| Env var | Default | What it does |
| --- | --- | --- |
| `DROPBOX_APP_KEY` | — | Dropbox app key. Required. |
| `DROPBOX_APP_SECRET` | — | Dropbox app secret. Required. |
| `DROPBOX_REFRESH_TOKEN` | — | Long-lived refresh token. Required. |
| `DROPBOX_BACKUP_FOLDER` | `''` | This site's folder inside the Dropbox app folder. Empty means the app folder root — right only for an app dedicated to one site; bootstrap warns. |
| `DROPBOX_BACKUP_PREFIX` | `strapi-backup-` | Filename prefix. Retention and the stale sweep match on it. Must end in `-` or `_`. |
| `DROPBOX_BACKUP_KEEP` | `14` | Archive runs kept in `daily/`. |
| `DROPBOX_BACKUP_MEDIA_KEEP` | `8` | Kept archive runs in `weekly/`, for instances still using that schedule. |
| `DROPBOX_BACKUP_CRON` | `0 30 3 * * *` | Database schedule. Empty disables it without disabling the plugin. |
| `DROPBOX_BACKUP_MEDIA_CRON` | `0 0 4 * * *` | Media-mirror schedule. Empty disables it. |
| `DROPBOX_BACKUP_MEDIA_MAX_MINUTES` | `60` | Time budget for one mirror pass; the next pass resumes. `0` disables the budget. |
| `DROPBOX_BACKUP_TZ` | `UTC` | Timezone the cron rules are read in. |
| `DROPBOX_BACKUP_SQL_DUMP` | `true` | Also write the raw `mysqldump` / `pg_dump`. |
| `DROPBOX_BACKUP_ENCRYPTION_KEY` | unset | Encrypts the archive; restoring then needs `strapi import --key`. Does not cover the SQL dump. |
| `DROPBOX_BACKUP_CHUNK_SIZE` | `8388608` | Upload-session chunk size. Must be a multiple of 4 MiB. |
| `DROPBOX_BACKUP_TMP_DIR` | `.tmp/backups` | Staging directory, resolved against the app root. |
| `DROPBOX_BACKUP_MIN_FREE_MB` | `1024` | Floor for the pre-run free-space check. |

## How it is laid out

```
Apps/<dropbox-app>/<DROPBOX_BACKUP_FOLDER>/
├── daily/     archives: database, schemas, media metadata   (keep 14)
└── media/     one object per media file, append-only        (never pruned)
```

Two independent things, on two schedules:

| | Archive | Media mirror |
| --- | --- | --- |
| Runs | nightly 03:30 UTC | nightly 04:00 UTC |
| Contains | database, schemas, media **metadata** | the media **bytes**, one object per file |
| Takes | a minute or two | long once, then seconds |
| Restore with | `strapi import` + `mysql` | re-upload the tree to the media provider |

**Media is mirrored rather than archived.** Putting ~11,000 files inside the
export archive meant a 90-minute run during which the transfer engine disables
every database lifecycle hook, and a run killed at minute 80 lost everything.
The mirror uploads only what Dropbox does not already have, so it resumes after
an interruption, costs one file rather than a whole archive when it dies, and
after the first pass finishes in seconds.

**The mirror is append-only on purpose.** Deleting from it to match Strapi would
mean that deleting images in the CMS also destroys the copy you would restore
them from. **Cloudflare R2 has no object versioning and cannot recover a deleted
object**, so for an R2-backed instance this mirror is the only route back.
Orphaned objects cost storage; storage is the thing there is plenty of.

Each archive run uploads two files to `daily/`:

| File | What it holds | How to restore |
| --- | --- | --- |
| `<prefix><stamp>.tar.gz` | Content entries, relations, **media binaries** (downloaded from the upload provider), content-type and component schemas, core store, webhooks, content-manager layouts | `strapi import` |
| `<prefix><stamp>.sql.gz` | A raw `mysqldump` of the whole database, including **admin users, admin roles and API tokens** | `mysql` |

`<stamp>` is compact UTC ISO8601, so both halves of a run share a name and the
folder sorts chronologically. On a SQLite instance the second file is a
`VACUUM INTO` snapshot named `.db.gz` instead.

## Why two files

The transfer engine behind `strapi export` filters every `admin::*` content type
on **both** export and import, so the `.tar.gz` deliberately does not contain
admin accounts, admin roles, API tokens or transfer tokens. The SQL dump is the
only artifact you can recover those from.

The reverse is also true: the `.tar.gz` is the only artifact that contains the
**media binaries**, because those live in the upload provider's bucket rather
than in the database.

So a full recovery needs both. Neither is a superset of the other.

The `.tar.gz` holds schemas, not `config/`. `config/plugins.js` and friends live
in git — do not expect to find them in the archive.

## Dropbox setup

One-time per Dropbox app, and it has to be done as the account that should own
the backups. Minting a refresh token (steps 3 to 6) is per site.

**One app, many sites.** Create one App-folder app holding one subfolder per
Strapi site, so each site sets its own `DROPBOX_BACKUP_FOLDER` and they share
the key, secret and refresh token.

Retention only matches `<prefix><stamp>.*` inside its own configured folder,
non-recursively, so one site can never prune another's backups even though they
share an app and a token. That token does reach every site's subfolder, which is
the trade for one app: if you want a leaked token to be unable to touch the
other sites, give the site its own App-folder app and leave
`DROPBOX_BACKUP_FOLDER` empty.

1. <https://www.dropbox.com/developers/apps> → **Create app** → *Scoped access* →
   **App folder** → name it.
2. **Permissions** tab → tick `files.content.write` and `files.content.read`
   → **Submit**, and check the page still shows them after a reload. Ticking
   `files.content.read` automatically enables and locks `files.metadata.read`,
   which `list_folder` needs, so those two ticks give all three scopes.

   That is the complete set. `files.metadata.write` is **not** needed — it
   covers moving and renaming, while this plugin only creates a folder, uploads,
   lists and deletes.

   Do this *before* step 4: scopes are baked into the token when it is minted,
   so adding one later means minting a new refresh token.
3. **Settings** tab → copy the **App key** and **App secret**.
4. **Sign the browser into the company (or shared) Dropbox account first.** An
   App-folder app creates its folder under `Apps/` in whichever account
   authorises it — authorise from a personal login and the backups land in that
   person's Dropbox and vanish when they leave. Then open:

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline
   ```

   and copy the authorisation code.
5. Trade the code for a refresh token. `bin/dropbox-token.sh` does steps 4 to 6
   in one go, run on the server, so neither the secret nor the token ever leaves
   the box or reaches your shell history:

   ```sh
   ssh <server>
   cd /path/to/the/strapi/site
   bash node_modules/strapi-plugin-dropbox-backup/bin/dropbox-token.sh
   ```

   It prompts for the folder and prefix for this site, then the app key, prints
   the authorise URL, prompts for the secret (hidden) and the code, exchanges
   them, and writes all five `DROPBOX_*` values into `.env` at mode 0600,
   backing up the old file first. On a failed exchange it changes nothing.

   By hand instead:

   ```sh
   curl -u <APP_KEY>:<APP_SECRET> \
     -d grant_type=authorization_code \
     -d code=<CODE> \
     https://api.dropboxapi.com/oauth2/token
   ```

   Take `refresh_token` from the response. The code is single-use; re-run step 4
   if you need another.
6. Restart the app so it picks up the new environment, e.g.
   `pm2 restart <app> --update-env`.

## Restore

### Content and media

```sh
strapi import --file <prefix><stamp>.tar.gz
# add --key <DROPBOX_BACKUP_ENCRYPTION_KEY> if the archive is encrypted (.enc)
```

This **erases and replaces** existing content. Restore into a throwaway instance
first if you are recovering a single entry rather than the whole site.

### Database, including admin accounts

```sh
gunzip -c <prefix><stamp>.sql.gz | mysql <database>
```

SQLite equivalent: `gunzip -c <prefix><stamp>.db.gz > .tmp/data.db`.

### Checking a backup without restoring it

```sh
tar tzf <prefix><stamp>.tar.gz
# expect: schemas/, entities/, links/, configuration/, assets/ (when media exists), metadata.json
```

## Operational notes

- **Run it at a quiet hour.** The transfer engine disables database lifecycle
  hooks for the whole duration of a run, so an entry created or published while a
  backup is in flight skips its `updatedAt` and any model lifecycle. The default
  schedule is 03:30 for that reason.
- **The schedule is interpreted in `DROPBOX_BACKUP_TZ`, default `UTC`.**
  node-schedule reads a bare cron rule in the server's local timezone, which
  shifts twice a year with daylight saving, so the zone is always passed
  explicitly.
- **Media dominates the runtime.** Assets are fetched one at a time over HTTP
  from the upload provider, two requests per file per format, so duration scales
  with the size of the media library rather than the database.
- **Disk.** Both artifacts are written to `DROPBOX_BACKUP_TMP_DIR` before upload
  and deleted afterwards, including when a run fails. A run is refused up front
  if free space looks insufficient, because the transfer engine reports a write
  failure in a way no caller can catch (see the comments in
  `server/services/archive.js`) — a disk that fills mid-write would otherwise
  take the process down.
- **One run at a time.** The cron jobs and the admin button share a single
  guard, and a second request while a run is in flight returns `409`.
- **Run history** (last 20 runs) lives in the core store under
  `plugin_dropbox-backup_runs`, not in a content type, so there is no migration
  and nothing to clean up if the plugin is removed.

## Layout

```
server/
  register.js        permission actions (plugin::dropbox-backup.read / .run)
  bootstrap.js       cron registration, skipped when unconfigured
  routes/            POST /dropbox-backup/run, GET /dropbox-backup/status (admin API)
  controllers/       202 + poll, never blocks on a run
  services/
    runner.js        orchestration, concurrency guard, run history
    preflight.js     writability and free-space check
    archive.js       strapi-export archive via @strapi/data-transfer
    sqldump.js       mysqldump / pg_dump / sqlite VACUUM INTO
    dropbox.js       OAuth refresh, chunked upload sessions, list, delete
    retention.js     prune by run, both halves together
    media.js         append-only mirror of the media objects
    sweep.js         removes staging files a killed run left behind
admin/src/           menu link and the status page
bin/dropbox-token.sh mints the refresh token on the server
```
