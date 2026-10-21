'use strict';

// Only the keys Strapi whitelists may appear here: the module schema is
// validated with .noUnknown(), so an extra key is a startup crash rather than
// something ignored.
module.exports = {
  register: require('./register'),
  bootstrap: require('./bootstrap'),
  destroy: require('./destroy'),
  config: require('./config'),
  routes: require('./routes'),
  controllers: require('./controllers'),
  services: require('./services'),
};
