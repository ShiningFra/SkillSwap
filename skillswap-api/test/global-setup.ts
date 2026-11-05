import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/** Recrée la base de test à partir des scripts SQL du dépôt, pour tester le vrai schéma et ses contraintes. */
export default async function () {
  const admin =
    process.env.TEST_ADMIN_URL ??
    'postgres://postgres@127.0.0.1:54329/postgres';
  const cible =
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres@127.0.0.1:54329/skillswap_api_test';
  const a = new Client({ connectionString: admin });
  await a.connect();
  await a.query('DROP DATABASE IF EXISTS skillswap_api_test WITH (FORCE)');
  await a.query('CREATE DATABASE skillswap_api_test');
  await a.end();
  const c = new Client({ connectionString: cible });
  await c.connect();
  for (const f of [
    '001_schema.sql',
    '002_seed.sql',
    '003_securite.sql',
    '005_moderation.sql',
    '006_moderation_charge.sql',
    '007_suppression_compte.sql',
    '008_reinitialisation_mdp.sql',
    '009_administrateurs.sql',
    '010_notification_lien.sql',
  ])
    await c.query(readFileSync(join(__dirname, '..', 'db', f), 'utf8'));
  await c.query(
    `INSERT INTO competence (libelle, categorie_id) SELECT 'Python', id FROM categorie ORDER BY id LIMIT 1`,
  );
  await c.query(
    `INSERT INTO competence (libelle, categorie_id) SELECT 'Anglais', id FROM categorie ORDER BY id LIMIT 1`,
  );
  await c.end();
}
