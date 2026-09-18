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
