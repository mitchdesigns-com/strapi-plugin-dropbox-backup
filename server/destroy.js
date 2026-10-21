'use strict';

const { CRON_JOB_NAME } = require('./utils');

module.exports = ({ strapi }) => {
  // No-op when bootstrap bailed out early (no credentials, or an empty
  // schedule) — remove() just matches nothing.
  strapi.cron.remove(CRON_JOB_NAME);
  strapi.cron.remove(`${CRON_JOB_NAME}-media`);
};
