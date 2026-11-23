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
        // Canonical control-panel location, linked from Site Setup. Aurora
        // matches this static path before its `@@controlpanel/:id` route.
        type: 'route',
        path: '/@@controlpanel/mr-scotty',
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

  // Live job updates for the Activity tab, as server-sent events. A resource
  // route: it has no component and no layout.
  config.registerRoute({
    type: 'route',
    path: '/@@controlpanel/mr-scotty/events',
    file: 'mr-scotty/routes/MrScottyEvents.ts',
    options: {
      id: 'mr-scotty-events',
    },
  });

  return config;
}
