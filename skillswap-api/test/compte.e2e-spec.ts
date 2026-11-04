import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configurerApp } from '../src/app.setup';
import { SmsPort } from '../src/shared/sms';

const ORIGINE = 'http://localhost:3000';
const MDP = 'un-mot-de-passe-solide';
let compteur = 0;

describe('Recherche complète, choix de compétence, suppression de compte', () => {
  let app: INestApplication;
  let pool: Pool;
  let competences: string[];

  beforeAll(async () => {
    process.env.THROTTLE_DISABLED = 'true';
    app = (
      await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SmsPort)
        .useValue({ envoyerCode: async () => undefined })
        .compile()
    ).createNestApplication();
    configurerApp(app);
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    competences = (
      await pool.query('SELECT id FROM competence ORDER BY libelle LIMIT 2')
    ).rows.map((r) => r.id);
  });
  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  type Membre = { agent: request.Agent; id: string; email: string };
  const post = (m: Membre, url: string, corps: object = {}) =>
    m.agent.post(url).set('Origin', ORIGINE).send(corps);

  async function membre(): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const email = `cpt${Date.now()}${n}@exemple.cm`;
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email,
        pseudo: `Compte${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    await pool.query(
      `UPDATE utilisateur SET telephone = $2, telephone_verifie_le = now() WHERE id = $1`,
      [res.body.id, `+2376${String(Date.now()).slice(-6)}${n % 10}${n % 7}`],
    );
    return { agent, id: res.body.id, email };
  }
  const offrir = (m: Membre, competenceId: string) =>
    pool.query(
      `INSERT INTO declaration_competence (utilisateur_id, competence_id, sens, niveau, format) VALUES ($1, $2, 'OFFERTE', 'AVANCE', 'LES_DEUX')`,
      [m.id, competenceId],
    );
  const chercher = (m: Membre, competenceId: string) =>
    pool.query(
      `INSERT INTO declaration_competence (utilisateur_id, competence_id, sens, niveau, format) VALUES ($1, $2, 'RECHERCHEE', 'DEBUTANT', 'LES_DEUX')`,
      [m.id, competenceId],
    );
  async function creneau(m: Membre, jours: number) {
    const debut = new Date(Date.now() + jours * 86_400_000);
    const r = await post(m, '/moi/creneaux', {
      debut: debut.toISOString(),
      fin: new Date(+debut + 3_600_000).toISOString(),
      format: 'LES_DEUX',
    });
    expect(r.status).toBe(201);
    return r.body.id as string;
  }

  it('la recherche renvoie toutes les offres et les compétences réciproques', async () => {
    const prof = await membre();
    const eleve = await membre();
    const troisieme = (
      await pool.query<{ id: string }>(
        `INSERT INTO competence (libelle, categorie_id) SELECT 'Test' || $1::text, id FROM categorie ORDER BY id LIMIT 1 RETURNING id`,
        [Date.now()],
      )
    ).rows[0].id;
    await offrir(prof, competences[1]);
    await offrir(prof, troisieme);
    await chercher(prof, competences[0]);
    await offrir(eleve, competences[0]);
    const res = await eleve.agent.get('/profils');
    const ligne = res.body.find((l: { id: string }) => l.id === prof.id);
    expect(ligne.offres).toHaveLength(2);
    expect(ligne.reciproques).toEqual([competences[0]]);
    const filtre = await eleve.agent.get(`/profils?competenceId=${troisieme}`);
    const l2 = filtre.body.find((l: { id: string }) => l.id === prof.id);
    expect(l2.offres).toHaveLength(1);
    expect(l2.reciproques).toEqual([competences[0]]);
  });

  it('la proposition exige la compétence quand l’enseignant en offre plusieurs', async () => {
    const prof = await membre();
    const eleve = await membre();
    await offrir(prof, competences[0]);
    await offrir(prof, competences[1]);
    const conv = (await post(eleve, '/conversations', { membreId: prof.id }))
      .body.id as string;
    const k = await creneau(prof, 20);
    const base = { creneauId: k, format: 'DISTANCE', contrepartie: 'TROC' };
    expect(
      (await post(eleve, `/conversations/${conv}/sessions`, base)).status,
    ).toBe(400);
    const ok = await post(eleve, `/conversations/${conv}/sessions`, {
      ...base,
      competenceId: competences[1],
    });
    expect(ok.status).toBe(201);
    const s = await pool.query(
      `SELECT competence_id FROM session_echange WHERE id = $1`,
      [ok.body.id],
    );
    expect(s.rows[0].competence_id).toBe(competences[1]);
  });

  it('supprime un compte par anonymisation (RG14)', async () => {
    const prof = await membre();
    const eleve = await membre();
    await offrir(prof, competences[0]);
    const conv = (await post(eleve, '/conversations', { membreId: prof.id }))
      .body.id as string;
    await post(eleve, `/conversations/${conv}/messages`, { texte: 'Bonjour' });
    await post(prof, `/conversations/${conv}/messages`, {
      texte: 'Mon numéro privé',
    });
    const k = await creneau(prof, 25);
    const s = await post(eleve, `/conversations/${conv}/sessions`, {
      creneauId: k,
      format: 'DISTANCE',
      contrepartie: 'TROC',
    });
    expect(s.status).toBe(201);

    expect(
      (await post(prof, '/moi/suppression', { motDePasse: 'faux' })).status,
    ).toBe(401);
    expect(
      (await post(prof, '/moi/suppression', { motDePasse: MDP })).status,
    ).toBe(204);
    expect((await prof.agent.get('/moi')).status).toBe(401);
    const login = await request(app.getHttpServer())
      .post('/auth/connexion')
      .set('Origin', ORIGINE)
      .send({ email: prof.email, motDePasse: MDP });
    expect(login.status).toBe(401);

    const u = (
      await pool.query(`SELECT * FROM utilisateur WHERE id = $1`, [prof.id])
    ).rows[0];
    expect(u.statut).toBe('SUPPRIME');
    expect(u.pseudo).toBe('Membre supprimé');
    expect(u.email).not.toBe(prof.email);
    expect(u.telephone).toBeNull();
    expect(u.bio).toBeNull();
    const msgs = await pool.query(
      `SELECT contenu FROM message WHERE expediteur_id = $1`,
      [prof.id],
    );
    expect(msgs.rows.every((m) => m.contenu === '[message supprimé]')).toBe(
      true,
    );
    const sess = await pool.query(
      `SELECT statut FROM session_echange WHERE id = $1`,
      [s.body.id],
    );
    expect(sess.rows[0].statut).toBe('ANNULEE');

    expect((await eleve.agent.get(`/profils/${prof.id}`)).status).toBe(404);
    const liste = await eleve.agent.get('/profils');
    expect(
      liste.body.find((l: { id: string }) => l.id === prof.id),
    ).toBeUndefined();
    expect(
      (
        await post(eleve, `/conversations/${conv}/messages`, {
          texte: 'Allô ?',
        })
      ).status,
    ).toBe(410);
  });

  it('refuse la suppression à un administrateur', async () => {
    const a = await membre();
    await pool.query(`UPDATE utilisateur SET role = 'ADMIN' WHERE id = $1`, [
      a.id,
    ]);
    expect(
      (await post(a, '/moi/suppression', { motDePasse: MDP })).status,
    ).toBe(403);
  });
});
