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

describe('Administration : indicateurs et modération', () => {
  let app: INestApplication;
  let pool: Pool;

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
  });
  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  type Membre = { agent: request.Agent; id: string };
  async function membre(role = 'MEMBRE'): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email: `adm${Date.now()}${n}@exemple.cm`,
        pseudo: `Adm${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    if (role === 'ADMIN')
      await pool.query(`UPDATE utilisateur SET role = 'ADMIN' WHERE id = $1`, [
        res.body.id,
      ]);
    return { agent, id: res.body.id };
  }
  const decider = (m: Membre, id: string, corps: object) =>
    m.agent
      .post(`/admin/signalements/${id}/decision`)
      .set('Origin', ORIGINE)
      .send(corps);

  async function signalement(cible: Membre, auteur: Membre) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO signalement (auteur_id, cible_id, motif, description) VALUES ($1, $2, 'SPAM', 'Publicité répétée') RETURNING id`,
      [auteur.id, cible.id],
    );
    return r.rows[0].id;
  }

  it('refuse les routes aux visiteurs et aux simples membres', async () => {
    const m = await membre();
    expect(
      (await request(app.getHttpServer()).get('/admin/indicateurs')).status,
    ).toBe(401);
    expect((await m.agent.get('/admin/indicateurs')).status).toBe(403);
    expect((await m.agent.get('/admin/signalements')).status).toBe(403);
    const r = await decider(m, '00000000-0000-4000-8000-000000000000', {
      decision: 'REJETER',
    });
    expect(r.status).toBe(403);
  });

  it('renvoie les indicateurs à un administrateur', async () => {
    const a = await membre('ADMIN');
    const res = await a.agent.get('/admin/indicateurs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        sessionsRealisees30j: expect.any(Number),
        conversations30j: expect.any(Number),
        competencesOffertes: expect.any(Number),
        competencesConfirmees: expect.any(Number),
        signalementsOuverts: expect.any(Number),
      }),
    );
  });

  it('liste, détaille et avertit sans exposer de données privées', async () => {
    const a = await membre('ADMIN');
    const cible = await membre();
    const s1 = await signalement(cible, await membre());
    await signalement(cible, await membre());
    const liste = await a.agent.get('/admin/signalements');
    const ligne = liste.body.find((l: { id: string }) => l.id === s1);
    expect(ligne.nbSignaleurs).toBe(2);
    const d = await a.agent.get(`/admin/signalements/${s1}`);
    expect(d.status).toBe(200);
    expect(d.body.historique.signaleursDistincts).toBe(2);
    expect(JSON.stringify(d.body)).not.toMatch(
      /"(telephone|email|latitude|longitude)"/,
    );
    expect(
      (
        await decider(a, s1, {
          decision: 'AVERTIR',
          commentaire: 'Premier avertissement',
        })
      ).status,
    ).toBe(204);
    const notif = await pool.query(
      `SELECT type FROM notification WHERE utilisateur_id = $1`,
      [cible.id],
    );
    expect(notif.rows.map((r) => r.type)).toContain('AVERTISSEMENT');
    expect((await decider(a, s1, { decision: 'REJETER' })).status).toBe(409);
    const audit = await pool.query(
      `SELECT 1 FROM journal_audit WHERE action = 'MODERATION' AND cible = $1`,
      [s1],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('trie la file par gravité puis par nombre de signaleurs distincts', async () => {
    const a = await membre('ADMIN');
    const faible = await membre();
    const grave = await membre();
    const sf = await signalement(faible, await membre());
    const sg = (
      await pool.query<{ id: string }>(
        `INSERT INTO signalement (auteur_id, cible_id, motif) VALUES ($1, $2, 'COMPORTEMENT_INAPPROPRIE') RETURNING id`,
        [(await membre()).id, grave.id],
      )
    ).rows[0].id;
    const liste = (await a.agent.get('/admin/signalements')).body as {
      id: string;
      gravite: string;
    }[];
    expect(liste.find((l) => l.id === sg)?.gravite).toBe('HAUTE');
    expect(liste.findIndex((l) => l.id === sg)).toBeLessThan(
      liste.findIndex((l) => l.id === sf),
    );
  });

  it('refuse le motif retiré « absence sans prévenir »', async () => {
    const m = await membre();
    const c = await membre();
    const r = await m.agent
      .post('/signalements')
      .set('Origin', ORIGINE)
      .send({ membreId: c.id, motif: 'ABSENCE_SANS_PREVENIR' });
    expect(r.status).toBe(400);
  });

  it('suspend le compte et révoque ses sessions', async () => {
    const a = await membre('ADMIN');
    const cible = await membre();
    const s = await signalement(cible, await membre());
    expect((await decider(a, s, { decision: 'SUSPENDRE' })).status).toBe(204);
    expect((await cible.agent.get('/moi')).status).toBe(401);
    const u = await pool.query(`SELECT statut FROM utilisateur WHERE id = $1`, [
      cible.id,
    ]);
    expect(u.rows[0].statut).toBe('SUSPENDU');
  });

  it('rejette un signalement et refuse une décision invalide', async () => {
    const a = await membre('ADMIN');
    const s = await signalement(await membre(), await membre());
    expect((await decider(a, s, { decision: 'BANNIR' })).status).toBe(400);
    expect((await decider(a, s, { decision: 'REJETER' })).status).toBe(204);
    const r = await pool.query(
      `SELECT statut, moderateur_id FROM signalement WHERE id = $1`,
      [s],
    );
    expect(r.rows[0]).toEqual({ statut: 'REJETE', moderateur_id: a.id });
  });
});
