#!/usr/bin/env bash
# Mints the Dropbox refresh token for strapi-plugin-dropbox-backup and writes
# it, with the app key and secret, into the site's .env.
#
# Runs ON the server, interactively, so the credentials never leave the box: the
# secret and the auth code are read from prompts rather than arguments, the
# exchange sends them on stdin rather than in argv (where `ps` would expose
# them), neither is echoed, and the refresh token goes straight into .env
# without ever being printed.
#
#   ssh <server>
#   cd /path/to/the/strapi/site        # the directory holding .env
#   bash node_modules/strapi-plugin-dropbox-backup/bin/dropbox-token.sh
#
# Then restart the app with its environment reloaded, e.g.
#   pm2 restart <app> --update-env
#
# Environment overrides:
#   SITE_DIR               site root; defaults to the current directory
#   ENV_FILE               .env path; defaults to $SITE_DIR/.env
#   DROPBOX_BACKUP_FOLDER  folder inside the Dropbox app folder for this site
#   DROPBOX_BACKUP_PREFIX  filename prefix for this site's backups
set -euo pipefail

SITE_DIR="${SITE_DIR:-$PWD}"
ENV_FILE="${ENV_FILE:-$SITE_DIR/.env}"
BACKUP_FOLDER="${DROPBOX_BACKUP_FOLDER:-}"
BACKUP_PREFIX="${DROPBOX_BACKUP_PREFIX:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No .env at $ENV_FILE - run this from the site root, or set SITE_DIR or ENV_FILE." >&2
  exit 1
fi

if [[ -z "$BACKUP_FOLDER" ]]; then
  read -r -p 'Dropbox folder for this site (e.g. /acme-cms): ' BACKUP_FOLDER
  [[ -n "$BACKUP_FOLDER" ]] || { echo "A folder is required when one Dropbox app serves several sites." >&2; exit 1; }
fi

# Retention matches on this prefix, so each site keeps its own and never prunes
# another's files even if two sites share a folder by mistake.
if [[ -z "$BACKUP_PREFIX" ]]; then
  SUGGESTED="$(printf '%s' "$BACKUP_FOLDER" | tr -d '/' | tr -c 'A-Za-z0-9._-' '-')-backup-"
  read -r -p "Backup filename prefix [$SUGGESTED]: " BACKUP_PREFIX
  BACKUP_PREFIX="${BACKUP_PREFIX:-$SUGGESTED}"
fi

read -r -p 'Dropbox App key: ' APP_KEY
[[ -n "$APP_KEY" ]] || { echo "App key is required." >&2; exit 1; }

cat <<EOF

Open this in a browser signed in as the Dropbox account that should own the
backups, approve, then paste the code below. The code is single-use and
expires within minutes.

  https://www.dropbox.com/oauth2/authorize?client_id=$APP_KEY&response_type=code&token_access_type=offline

EOF

# -s keeps the secret off the screen; neither value reaches the shell history,
# because nothing here is typed as a command.
read -r -s -p 'Dropbox App secret: ' APP_SECRET; echo
read -r    -p 'Authorization code: ' AUTH_CODE
[[ -n "$APP_SECRET" && -n "$AUTH_CODE" ]] || { echo "Secret and code are both required." >&2; exit 1; }

echo
echo "==> Exchanging the code for a refresh token"

# The body goes over stdin, so the secret never appears in this process's argv.
RESPONSE=$(
  printf 'grant_type=authorization_code&code=%s&client_id=%s&client_secret=%s' \
    "$AUTH_CODE" "$APP_KEY" "$APP_SECRET" \
    | curl -sS -X POST --data-binary @- https://api.dropboxapi.com/oauth2/token
)

REFRESH_TOKEN=$(printf '%s' "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refresh_token",""))' 2>/dev/null || true)

if [[ -z "$REFRESH_TOKEN" ]]; then
  # Surface Dropbox's own error, which never contains the secret, but strip any
  # token-shaped field just in case a future response carries one.
  echo "Token exchange failed. Dropbox said:" >&2
  printf '%s\n' "$RESPONSE" | sed -E 's/"(access|refresh)_token":"[^"]*"/"\1_token":"<redacted>"/g' >&2
  echo >&2
  echo "Most likely: the code was already used, it expired, or the secret is wrong." >&2
  echo "Get a fresh code from the URL above and run this again." >&2
  exit 1
fi

echo "==> Writing credentials into $ENV_FILE"

# The backup holds the same production secrets as .env, so it is created
# owner-only rather than inheriting whatever mode .env happened to have.
ENV_BACKUP="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
( umask 077 && cp "$ENV_FILE" "$ENV_BACKUP" )

set_var() {
  local key="$1" value="$2"
  # Replace an existing assignment in place, else append. Done with python so a
  # value containing & or / cannot break the substitution the way sed would.
  KEY="$key" VALUE="$value" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os, re

key = os.environ['KEY']
value = os.environ['VALUE']
path = os.environ['ENV_FILE']

with open(path) as fh:
    text = fh.read()

line = '{}={}'.format(key, value)
pattern = re.compile(r'^{}=.*$'.format(re.escape(key)), re.MULTILINE)

if pattern.search(text):
    text = pattern.sub(lambda _: line, text, count=1)
else:
    if text and not text.endswith('\n'):
        text += '\n'
    text += line + '\n'

with open(path, 'w') as fh:
    fh.write(text)
PY
}

set_var DROPBOX_APP_KEY       "$APP_KEY"
set_var DROPBOX_APP_SECRET    "$APP_SECRET"
set_var DROPBOX_REFRESH_TOKEN "$REFRESH_TOKEN"
set_var DROPBOX_BACKUP_FOLDER "$BACKUP_FOLDER"
set_var DROPBOX_BACKUP_PREFIX "$BACKUP_PREFIX"

chmod 600 "$ENV_FILE"

unset APP_SECRET AUTH_CODE REFRESH_TOKEN RESPONSE

cat <<EOF

Done. $ENV_FILE now has DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
DROPBOX_REFRESH_TOKEN, DROPBOX_BACKUP_FOLDER=$BACKUP_FOLDER and
DROPBOX_BACKUP_PREFIX=$BACKUP_PREFIX.
The previous .env was copied to $ENV_BACKUP (owner-only). Delete it once the
first backup has run — it holds the same production secrets.

Next, restart the app with its environment reloaded, e.g.

  pm2 restart <app> --update-env

Then open Admin -> Dropbox backup. The "not configured" banner should be gone
and "Back up now" enabled. Run one and watch the history row.
EOF
