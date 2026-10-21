import BackupIcon from './components/BackupIcon.jsx';

const PLUGIN_ID = 'dropbox-backup';

export default {
  // register receives the app itself, not { app }. `to` has to be relative:
  // a leading slash is stripped with a console warning.
  register(app) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: BackupIcon,
      intlLabel: {
        id: `${PLUGIN_ID}.plugin.name`,
        defaultMessage: 'Dropbox backup',
      },
      permissions: [{ action: `plugin::${PLUGIN_ID}.read`, subject: null }],
      Component: () => import('./pages/HomePage.jsx').then((mod) => ({ default: mod.HomePage })),
    });
  },
};
