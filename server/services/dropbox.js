'use strict';

const fs = require('fs');
const { getConfig, LOG } = require('../utils');

const TOKEN_URL = 'https://api.dropbox.com/oauth2/token';
const RPC_URL = 'https://api.dropboxapi.com/2';
const CONTENT_URL = 'https://content.dropboxapi.com/2';

// Refresh a minute early rather than racing the expiry on a long upload.
const TOKEN_SKEW_MS = 60 * 1000;

const MAX_ATTEMPTS = 4;

// Dropbox-API-Arg travels in an HTTP header, which may only carry ASCII, so any
// non-ASCII character in a path has to go through as a JSON escape.
const NON_ASCII = /[^\x00-\x7e]/g;

const apiArg = (value) =>
  JSON.stringify(value).replace(
    NON_ASCII,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 429 and 5xx are the two documented transient cases. Everything else is a real
// error and retrying it would only delay the failure.
const isRetryable = (status) => status === 429 || (status >= 500 && status < 600);

const describe = async (response) => {
  const body = await response.text().catch(() => '');
  return `${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ''}`;
};

module.exports = ({ strapi }) => {
  let cachedToken = null;

  const request = async (url, init, { label }) => {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        // Network-level failure (DNS, reset, timeout) - same backoff as a 5xx.
        lastError = new Error(`${label} failed: ${err.message}`);
        if (attempt === MAX_ATTEMPTS) throw lastError;
        await sleep(2 ** attempt * 500);
        continue;
      }

      if (response.ok) return response;

      if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
        strapi.log.warn(`${LOG} ${label} got ${response.status}, retrying in ${waitMs}ms`);
        await response.text().catch(() => {});
        await sleep(waitMs);
        continue;
      }

      throw new Error(`${label} failed: ${await describe(response)}`);
    }

    throw lastError;
  };

  // Long-lived access tokens are retired, so the .env holds a refresh token and
  // the process trades it for a short-lived access token as needed.
  const getAccessToken = async () => {
    if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > Date.now()) {
      return cachedToken.token;
    }

    const { appKey, appSecret, refreshToken } = getConfig(strapi);
    const basic = Buffer.from(`${appKey}:${appSecret}`).toString('base64');

    const response = await request(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      },
      { label: 'token refresh' }
    );

    const body = await response.json();
    cachedToken = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 14400) * 1000,
    };

    return cachedToken.token;
  };

  const rpc = async (endpoint, payload) => {
    const token = await getAccessToken();

    const response = await request(
      `${RPC_URL}/${endpoint}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload ?? null),
      },
      { label: endpoint }
    );

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const content = async (endpoint, arg, body) => {
    const token = await getAccessToken();

    const response = await request(
      `${CONTENT_URL}/${endpoint}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': apiArg(arg),
        },
        body,
      },
      { label: endpoint }
    );

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  // Dropbox creates missing parents on upload anyway, but creating the folder up
  // front makes a wrong DROPBOX_BACKUP_FOLDER fail loudly on the first run
  // instead of quietly scattering archives somewhere unexpected.
  const ensureFolder = async (folder) => {
    // The app-folder root always exists and cannot be created.
    if (!folder) return;

    try {
      await rpc('files/create_folder_v2', { path: folder, autorename: false });
    } catch (err) {
      // path/conflict/folder is the normal case on every run after the first.
      if (!/conflict/.test(err.message)) throw err;
    }
  };

  // Always an upload session, even for a small file: single-shot files/upload
  // caps out around 150 MB and the session path has no upper bound, so one code
  // path covers every archive size. Chunks are read straight from disk - PM2
  // restarts the app at 1 GB RSS, so the archive must never be held in memory.
  const uploadFile = async ({ localPath, dropboxPath, chunkSize }) => {
    const handle = await fs.promises.open(localPath, 'r');

    try {
      const { size } = await handle.stat();
      const buffer = Buffer.allocUnsafe(chunkSize);

      const readChunk = async (offset) => {
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset);
        return buffer.subarray(0, bytesRead);
      };

      const first = await readChunk(0);
      const { session_id: sessionId } = await content(
        'files/upload_session/start',
        { close: false },
        first
      );

      let offset = first.length;

      while (offset < size) {
        const chunk = await readChunk(offset);
        await content(
          'files/upload_session/append_v2',
          { cursor: { session_id: sessionId, offset }, close: false },
          chunk
        );
        offset += chunk.length;
      }

      const metadata = await content(
        'files/upload_session/finish',
        {
          cursor: { session_id: sessionId, offset },
          commit: { path: dropboxPath, mode: 'add', autorename: false, mute: true },
        },
        Buffer.alloc(0)
      );

      return { path: metadata.path_display, bytes: size };
    } finally {
      await handle.close();
    }
  };

  // One request per object, for the media mirror. Files there average a couple
  // of hundred KB, so an upload session's three round-trips would triple the
  // cost of syncing eleven thousand of them for no benefit.
  const uploadData = async ({ dropboxPath, data }) => {
    try {
      const metadata = await content(
        'files/upload',
        { path: dropboxPath, mode: 'add', autorename: false, mute: true },
        data
      );
      return { path: metadata.path_display, bytes: data.length };
    } catch (err) {
      // Already there: the mirror is append-only, so an existing object is a
      // success, not a collision to resolve.
      if (/conflict/.test(err.message)) return { path: dropboxPath, bytes: 0 };
      throw err;
    }
  };

  const listFolder = async (folder) => {
    const entries = [];
    let page = await rpc('files/list_folder', { path: folder, recursive: false });

    for (;;) {
      entries.push(...page.entries);
      if (!page.has_more) break;
      page = await rpc('files/list_folder/continue', { cursor: page.cursor });
    }

    return entries;
  };

  const deleteFile = (dropboxPath) => rpc('files/delete_v2', { path: dropboxPath });

  return { getAccessToken, ensureFolder, uploadFile, uploadData, listFolder, deleteFile };
};
