import type { ConfigType } from '@plone/registry';
import installRoutes from './config/routes';

export default function install(config: ConfigType) {
  installRoutes(config);

  return config;
}
