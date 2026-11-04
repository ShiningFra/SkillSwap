/** Configuration lue à l'appel (et non à l'import) pour que les tests puissent fixer l'environnement. */
export interface Config {
  production: boolean;
  databaseUrl: string;
  allowedOrigin: string;
  cookieSecure: boolean;
  smsPepper: string;
  sessionJours: number;
  throttleLimit: number;
}

export function config(): Config {
  const production = process.env.NODE_ENV === 'production';
  const smsPepper =
    process.env.SMS_PEPPER ?? (production ? '' : 'dev-pepper-non-secret');
  if (production && smsPepper.length < 32) {
    // ES12 : pas de secret par défaut en production.
    throw new Error(
      'SMS_PEPPER (32 caractères au moins) est obligatoire en production',
    );
  }
  return {
    production,
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgres://postgres@localhost:5432/skillswap',
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : production,
    smsPepper,
    sessionJours: 7,
    throttleLimit: Number(process.env.THROTTLE_LIMIT ?? 100),
  };
}
