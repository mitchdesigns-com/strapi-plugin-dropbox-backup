'use strict';

// Registering here rather than in bootstrap() is mandatory: the action provider
// throws once strapi.isLoaded is true. `category` and `subjects` are rejected
// for section 'plugins' by the provider's .noUnknown() validator.
const ACTIONS = [
  {
    section: 'plugins',
    pluginName: 'dropbox-backup',
    uid: 'read',
    displayName: 'Read backup status',
  },
  {
    section: 'plugins',
    pluginName: 'dropbox-backup',
    uid: 'run',
    displayName: 'Run a backup now',
  },
];

module.exports = async ({ strapi }) => {
  await strapi.service('admin::permission').actionProvider.registerMany(ACTIONS);
};
