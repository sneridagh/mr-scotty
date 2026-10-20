import type { ConfigType } from '@plone/registry';

export default function install(config: ConfigType) {
  config.registerRoute({
    type: 'layout',
    file: '@plone/cmsui/routes/layout.tsx',
    options: {
      id: 'mr-scotty-layout',
    },
    children: [
      {
        // Canonical control-panel location, linked from Site Setup.
        type: 'route',
        path: '/controlpanel/mr-scotty',
        file: 'mr-scotty/routes/MrScotty.tsx',
        options: {
          id: 'mr-scotty-controlpanel',
        },
      },
      {
        // Kept as a stable direct entry point.
        type: 'route',
        path: '/mr-scotty',
        file: 'mr-scotty/routes/MrScotty.tsx',
        options: {
          id: 'mr-scotty',
        },
      },
    ],
  });

  return config;
}
