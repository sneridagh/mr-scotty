import type { ConfigType } from '@plone/registry';
import installRoutes from './config/routes';

export default function install(config: ConfigType) {
  installRoutes(config);

  // Surface Mr. Scotty in Site Setup. The list links to
  // `/controlpanel/<id>`, which the add-on registers as a custom route.
  config.settings.controlpanels = [
    ...(config.settings.controlpanels || []),
    {
      '@id': '/mr-scotty',
      title: 'Mr. Scotty',
      group: 'Content',
    },
  ];

  return config;
}
