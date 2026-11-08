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

describe('Administration : gestion des comptes administrateurs', () => {
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

  type Membre = { agent: request.Agent; id: string; email: string };
  async function membre(role = 'MEMBRE'): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const email = `ga${Date.now()}${n}@exemple.cm`;
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email,
        pseudo: `Ga${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    if (role === 'ADMIN')
      await pool.query(`UPDATE utilisateur SET role='ADMIN' WHERE id=$1`, [
        res.body.id,
      ]);
    return { agent, id: res.body.id, email };
  }
  const post = (m: Membre, url: string, corps: object) =>
    m.agent.post(url).set('Origin', ORIGINE).send(corps);

  it('refuse un simple membre', async () => {
    const m = await membre();
    expect((await m.agent.get('/admin/administrateurs')).status).toBe(403);
    expect(
      (
        await post(m, '/admin/administrateurs/nommer', {
          email: m.email,
          motDePasse: MDP,
        })
      ).status,
    ).toBe(403);
  });

  it('nomme un membre existant, après confirmation du mot de passe', async () => {
    const a = await membre('ADMIN');
    const m = await membre();
    const faux = await post(a, '/admin/administrateurs/nommer', {
      email: m.email,
      motDePasse: 'mauvais-mot-de-passe',
    });
    expect(faux.status).toBe(401);
    expect((await m.agent.get('/admin/indicateurs')).status).toBe(403);
    expect(
      (
        await post(a, '/admin/administrateurs/nommer', {
          email: m.email,
          motDePasse: MDP,
        })
      ).status,
    ).toBe(204);
    expect((await m.agent.get('/admin/indicateurs')).status).toBe(200);
    expect(
      (
        await post(a, '/admin/administrateurs/nommer', {
          email: m.email,
          motDePasse: MDP,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(a, '/admin/administrateurs/nommer', {
          email: 'inconnu@exemple.cm',
          motDePasse: MDP,
        })
      ).status,
    ).toBe(404);
    const audit = await pool.query(
      `SELECT detail FROM journal_audit WHERE action='ADMIN_NOMME' AND cible=$1`,
      [m.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain(MDP);
  });

  it('refuse de nommer un compte suspendu', async () => {
    const a = await membre('ADMIN');
    const m = await membre();
    await pool.query(`UPDATE utilisateur SET statut='SUSPENDU' WHERE id=$1`, [
      m.id,
    ]);
    expect(
      (
        await post(a, '/admin/administrateurs/nommer', {
          email: m.email,
          motDePasse: MDP,
        })
      ).status,
    ).toBe(409);
  });

  it("crée un compte avec mot de passe provisoire, bloqué jusqu'au changement", async () => {
    const a = await membre('ADMIN');
    const email = `nouv${Date.now()}@exemple.cm`;
    const res = await post(a, '/admin/administrateurs/creer', {
      email,
      pseudo: 'NouvelAdmin',
      motDePasse: MDP,
    });
    expect(res.status).toBe(201);
    const prov: string = res.body.motDePasseProvisoire;
    expect(prov).toHaveLength(16);
    expect(
      (
        await post(a, '/admin/administrateurs/creer', {
          email,
          pseudo: 'Autre',
          motDePasse: MDP,
        })
      ).status,
    ).toBe(409);

    const n = request.agent(app.getHttpServer());
    expect(
      (
        await n
          .post('/auth/connexion')
          .set('Origin', ORIGINE)
          .send({ email, motDePasse: prov })
      ).status,
    ).toBe(200);
    const moi = await n.get('/moi');
    expect(moi.status).toBe(200);
    expect(moi.body.mdpProvisoire).toBe(true);
    const bloque = await n.get('/admin/indicateurs');
    expect(bloque.status).toBe(403);
    expect(bloque.body.cle).toBe('errors.mdpProvisoire');

    const ch = await n
      .post('/moi/mot-de-passe')
      .set('Origin', ORIGINE)
      .send({ actuel: prov, nouveau: 'nouveau-mot-de-passe-1' });
    expect(ch.status).toBe(204);
    expect((await n.get('/moi')).body.mdpProvisoire).toBe(false);
    expect((await n.get('/admin/indicateurs')).status).toBe(200);
  });

  it('protège contre le retrait de soi-même et du dernier administrateur', async () => {
    const a = await membre('ADMIN');
    const b = await membre('ADMIN');
    expect(
      (
        await post(a, `/admin/administrateurs/${a.id}/retirer`, {
          motDePasse: MDP,
        })
      ).status,
    ).toBe(409);
    // on isole : tous les autres administrateurs sont rétrogradés sauf a et b
    await pool.query(
      `UPDATE utilisateur SET role='MEMBRE' WHERE role='ADMIN' AND id NOT IN ($1,$2)`,
      [a.id, b.id],
    );
    expect(
      (
        await post(a, `/admin/administrateurs/${b.id}/retirer`, {
          motDePasse: 'mauvais-mot-de-passe',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post(a, `/admin/administrateurs/${b.id}/retirer`, {
          motDePasse: MDP,
        })
      ).status,
    ).toBe(204);
    expect((await b.agent.get('/admin/indicateurs')).status).toBe(403);
    // a est maintenant le seul : b (redevenu membre) ne peut rien, et a ne peut se retirer lui-même
    expect(
      (
        await post(a, `/admin/administrateurs/${a.id}/retirer`, {
          motDePasse: MDP,
        })
      ).status,
    ).toBe(409);
  });
});
