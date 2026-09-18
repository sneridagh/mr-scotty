// Reuse Aurora's signed-cookie helper. Route loaders use the httpOnly
// `auth_seven` cookie, not the legacy Volto `auth_token` cookie.
export {
  login,
  type LoginOptions,
} from '../../core/packages/tooling/playwright/login';
