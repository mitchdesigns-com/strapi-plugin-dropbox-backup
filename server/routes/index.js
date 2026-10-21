'use strict';

// type 'admin' mounts these on the admin API, which has no prefix, so the
// router prefix is the plugin name alone: /dropbox-backup/... (not /api/...).
// isAuthenticatedAdmin only asserts that someone is signed in, so the
// permission check has to be a second policy.
module.exports = {
  admin: {
    type: 'admin',
    routes: [
      {
        method: 'POST',
        path: '/run',
        handler: 'backup.run',
        config: {
          policies: [
            'admin::isAuthenticatedAdmin',
            {
              name: 'admin::hasPermissions',
              config: { actions: ['plugin::dropbox-backup.run'] },
            },
          ],
        },
      },
      {
        method: 'GET',
        path: '/status',
        handler: 'backup.status',
        config: {
          policies: [
            'admin::isAuthenticatedAdmin',
            {
              name: 'admin::hasPermissions',
              config: { actions: ['plugin::dropbox-backup.read'] },
            },
          ],
        },
      },
    ],
  },
};
