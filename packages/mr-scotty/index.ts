import type { ConfigType } from '@plone/registry';
import installRoutes from './config/routes';
import BeamIcon from './components/BeamIcon';

export default function install(config: ConfigType) {
  installRoutes(config);

  // Surface Mr. Scotty in Site Setup. The list links to
  // `/@@controlpanel/<id>`, which the add-on registers as a custom route.
  config.settings.controlpanels = [
    ...(config.settings.controlpanels || []),
    {
      '@id': '/mr-scotty',
      title: 'Mr. Scotty',
      group: 'Content',
    },
  ];
  // Its Site Setup icon; the description is the
  // `cmsui.controlpanelDescriptions.mr-scotty` translation in `locales`.
  config.settings.controlPanelsIcons = {
    ...config.settings.controlPanelsIcons,
    'mr-scotty': BeamIcon,
  };

  return config;
}
