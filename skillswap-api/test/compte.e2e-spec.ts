import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
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
    const res = await eleve.agent.get(
      `/profils?competenceIds=${competences[1]},${troisieme}`,
    );
    const ligne = res.body.resultats.find(
      (l: { id: string }) => l.id === prof.id,
    );
    expect(ligne.offres).toHaveLength(2);
    expect(ligne.reciproques).toEqual([competences[0]]);
    const filtre = await eleve.agent.get(`/profils?competenceId=${troisieme}`);
    const l2 = filtre.body.resultats.find(
      (l: { id: string }) => l.id === prof.id,
    );
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
    const liste = await eleve.agent.get('/profils?limite=50');
    expect(
      liste.body.resultats.find((l: { id: string }) => l.id === prof.id),
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

  it('modifie le profil, une compétence et gère ses créneaux', async () => {
    const m = await membre();
    await pool.query(
      `UPDATE utilisateur SET mode_localisation = 'MANUELLE', ville = 'Douala' WHERE id = $1`,
      [m.id],
    );
    const put = (url: string, corps: object) =>
      m.agent.put(url).set('Origin', ORIGINE).send(corps);
    expect((await put('/moi/profil', { pseudo: 'X' })).status).toBe(400);
    expect(
      (
        await put('/moi/profil', {
          pseudo: 'Nouveau nom',
          bio: 'Prof',
          ville: 'Yaoundé',
        })
      ).status,
    ).toBe(204);
    const moi = (await m.agent.get('/moi')).body;
    expect(moi.pseudo).toBe('Nouveau nom');
    expect(moi.bio).toBe('Prof');
    expect(moi.ville).toBe('Yaoundé');

    await offrir(m, competences[0]);
    expect(
      (
        await put(`/moi/competences/${competences[0]}`, {
          niveau: 'DEBUTANT',
          format: 'DISTANCE',
          preuveUrl: 'https://exemple.cm/x',
        })
      ).status,
    ).toBe(204);
    const decl = (await m.agent.get('/moi/competences')).body.find(
      (d: { competenceId: string }) => d.competenceId === competences[0],
    );
    expect(decl).toMatchObject({
      niveau: 'DEBUTANT',
      format: 'DISTANCE',
      preuveUrl: 'https://exemple.cm/x',
    });
    // une compétence recherchée ne porte pas de preuve (RG18) ; une inconnue est introuvable
    await chercher(m, competences[1]);
    expect(
      (
        await put(`/moi/competences/${competences[1]}`, {
          niveau: 'DEBUTANT',
          format: 'LES_DEUX',
          preuveUrl: 'https://exemple.cm/x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put('/moi/competences/00000000-0000-4000-8000-000000000000', {
          niveau: 'DEBUTANT',
          format: 'LES_DEUX',
        })
      ).status,
    ).toBe(404);

    const libre = await creneau(m, 30);
    const reserve = await creneau(m, 32);
    await pool.query(`UPDATE creneau SET statut = 'RESERVE' WHERE id = $1`, [
      reserve,
    ]);
    const liste = (await m.agent.get('/moi/creneaux')).body;
    expect(liste).toHaveLength(2);
    expect(liste[0].libelle).toMatch(/\d+ h/);
    const del = (id: string) =>
      m.agent.delete(`/moi/creneaux/${id}`).set('Origin', ORIGINE);
    expect((await del(reserve)).status).toBe(409);
    expect((await del(libre)).status).toBe(204);
    expect((await del(libre)).status).toBe(404);
    expect((await m.agent.get('/moi/creneaux')).body).toHaveLength(1);
  });

  it('refuse une requête qui modifie sans en-tête Origin quand un cookie de session est présent (ES4)', async () => {
    const m = await membre();
    await m.agent
      .put('/moi/profil')
      .send({ pseudo: 'Sans origine' })
      .expect(403);
    await m.agent
      .put('/moi/profil')
      .set('Origin', 'http://evil.example')
      .send({ pseudo: 'Origine etrangere' })
      .expect(403);
  });

  it('change le mot de passe et révoque les autres sessions', async () => {
    const m = await membre();
    const autre = request.agent(app.getHttpServer());
    expect(
      (
        await autre
          .post('/auth/connexion')
          .set('Origin', ORIGINE)
          .send({ email: m.email, motDePasse: MDP })
      ).status,
    ).toBe(200);
    const change = (corps: object) => post(m, '/moi/mot-de-passe', corps);
    expect(
      (await change({ actuel: 'faux', nouveau: 'un-autre-mot-de-passe' }))
        .status,
    ).toBe(401);
    expect((await change({ actuel: MDP, nouveau: 'court' })).status).toBe(400);
    expect(
      (await change({ actuel: MDP, nouveau: 'un-autre-mot-de-passe' })).status,
    ).toBe(204);
    expect((await m.agent.get('/moi')).status).toBe(200);
    expect((await autre.get('/moi')).status).toBe(401);
    const ancien = await request(app.getHttpServer())
      .post('/auth/connexion')
      .set('Origin', ORIGINE)
      .send({ email: m.email, motDePasse: MDP });
    expect(ancien.status).toBe(401);
    const neuf = await request(app.getHttpServer())
      .post('/auth/connexion')
      .set('Origin', ORIGINE)
      .send({ email: m.email, motDePasse: 'un-autre-mot-de-passe' });
    expect(neuf.status).toBe(200);
  });

  it('change de numéro : masqué, ancien conservé jusqu’à la vérification', async () => {
    const m = await membre();
    const avant = (await m.agent.get('/moi')).body;
    expect(avant.telephoneVerifie).toBe(true);
    expect(avant.telephoneMasque).toMatch(/^\+237 \d •• •• \d\d \d\d$/);
    expect(JSON.stringify(avant)).not.toMatch(/"telephone":/);
    const actuel = (
      await pool.query(`SELECT telephone FROM utilisateur WHERE id = $1`, [
        m.id,
      ])
    ).rows[0].telephone as string;
    expect(
      (await post(m, '/telephone/code', { telephone: actuel })).status,
    ).toBe(409);
    const neuf = `+23769${String(Date.now()).slice(-7)}`;
    expect((await post(m, '/telephone/code', { telephone: neuf })).status).toBe(
      202,
    );
    // tant que le code n'est pas validé, l'ancien numéro reste vérifié
    const encore = await pool.query(
      `SELECT telephone, telephone_verifie_le FROM utilisateur WHERE id = $1`,
      [m.id],
    );
    expect(encore.rows[0].telephone).toBe(actuel);
    expect(encore.rows[0].telephone_verifie_le).not.toBeNull();
    // le code n'est pas lisible ici (SMS simulé) : on le remplace par un code connu
    const v = await pool.query<{ id: string }>(
      `SELECT id FROM verification_telephone WHERE utilisateur_id = $1 AND telephone = $2`,
      [m.id, neuf],
    );
    const hash = createHmac(
      'sha256',
      process.env.SMS_PEPPER ?? 'dev-pepper-non-secret',
    )
      .update(`${v.rows[0].id}:123456`)
      .digest('hex');
    await pool.query(
      `UPDATE verification_telephone SET code_hash = $2 WHERE id = $1`,
      [v.rows[0].id, hash],
    );
    expect(
      (await post(m, '/telephone/verifier', { code: '654321' })).status,
    ).toBe(400);
    expect(
      (await post(m, '/telephone/verifier', { code: '123456' })).status,
    ).toBe(200);
    const apres = await pool.query(
      `SELECT telephone FROM utilisateur WHERE id = $1`,
      [m.id],
    );
    expect(apres.rows[0].telephone).toBe(neuf);
  });
});
