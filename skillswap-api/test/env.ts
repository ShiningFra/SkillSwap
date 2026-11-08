// Environnement des tests : base dédiée, jamais la base de développement.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres@127.0.0.1:54329/skillswap_api_test';
process.env.ALLOWED_ORIGIN = 'http://localhost:3000';
process.env.COOKIE_SECURE = 'false';
process.env.EMBEDDINGS_DISABLED = process.env.EMBEDDINGS_DISABLED ?? 'true';
