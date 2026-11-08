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

describe('Paramètres : interrupteurs de fonctionnalités', () => {
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
    await pool.query(`UPDATE parametre SET actif = true, message = NULL`);
    await pool.end();
    await app.close();
  });

  type Membre = { agent: request.Agent; id: string };
  async function membre(admin = false): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email: `par${Date.now()}${n}@exemple.cm`,
        pseudo: `Par${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    if (admin)
      await pool.query(`UPDATE utilisateur SET role = 'ADMIN' WHERE id = $1`, [
        res.body.id,
      ]);
    return { agent, id: res.body.id };
  }
  const regler = (
    m: Membre,
    cle: string,
    corps: { actif: boolean; message?: string; motDePasse?: string },
  ) =>
    m.agent
      .put(`/admin/parametres/${cle}`)
      .set('Origin', ORIGINE)
      .send({ motDePasse: MDP, ...corps });

  it('liste publique : sept interrupteurs, tous actifs au départ', async () => {
    const res = await request(app.getHttpServer()).get('/parametres');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(7);
    expect(res.body.every((p: { actif: boolean }) => p.actif)).toBe(true);
  });

  it('réservé aux administrateurs, avec mot de passe, clé connue', async () => {
    const simple = await membre();
    const admin = await membre(true);
    expect(
      (await regler(simple, 'inscriptions', { actif: false })).status,
    ).toBe(403);
    expect(
      (
        await regler(admin, 'inscriptions', {
          actif: false,
          motDePasse: 'mauvais-mot-de-passe',
        })
      ).status,
    ).toBe(401);
    expect((await regler(admin, 'inconnue', { actif: false })).status).toBe(
      404,
    );
    expect((await admin.agent.get('/admin/parametres')).status).toBe(200);
    expect((await simple.agent.get('/admin/parametres')).status).toBe(403);
  });

  it('vérification du téléphone : désactivée, plus exigée ; réactivée, exigée de nouveau', async () => {
    const admin = await membre(true);
    const a = await membre();
    const b = await membre();
    const ouvrir = (m: Membre, cible: string) =>
      m.agent
        .post('/conversations')
        .set('Origin', ORIGINE)
        .send({ membreId: cible });

    expect((await ouvrir(a, b.id)).status).toBe(403);

    const off = await regler(admin, 'verification_telephone', {
      actif: false,
      message: 'En révision jusqu’à lundi',
    });
    expect(off.status).toBe(204);
    const pub = await request(app.getHttpServer()).get('/parametres');
    const p = pub.body.find(
      (x: { cle: string }) => x.cle === 'verification_telephone',
    );
    expect(p).toEqual({
      cle: 'verification_telephone',
      actif: false,
      message: 'En révision jusqu’à lundi',
    });

    const code = await a.agent
      .post('/telephone/code')
      .set('Origin', ORIGINE)
      .send({ telephone: '+237677000111' });
    expect(code.status).toBe(503);
    expect((await ouvrir(a, b.id)).status).toBe(201);

    expect(
      (await regler(admin, 'verification_telephone', { actif: true })).status,
    ).toBe(204);
    const c = await membre();
    expect((await ouvrir(c, b.id)).status).toBe(403);

    const audit = await pool.query(
      `SELECT 1 FROM journal_audit WHERE acteur_id = $1 AND action = 'PARAMETRE_MODIFIE'`,
      [admin.id],
    );
    expect(audit.rowCount).toBe(2);
  });

  it('inscriptions fermées et propositions de compétences coupées', async () => {
    const admin = await membre(true);
    const m = await membre();
    await regler(admin, 'inscriptions', { actif: false });
    const ins = await request(app.getHttpServer())
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email: `ferme${Date.now()}@exemple.cm`,
        pseudo: 'Ferme',
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(ins.status).toBe(503);
    expect(ins.body.cle).toBe('errors.enRevision');
    await regler(admin, 'inscriptions', { actif: true });

    await regler(admin, 'propositions_competences', { actif: false });
    const cat = (await pool.query('SELECT id FROM categorie LIMIT 1')).rows[0]
      .id;
    const prop = await m.agent
      .post('/competences')
      .set('Origin', ORIGINE)
      .send({ libelle: `Interdite ${Date.now()}`, categorieId: cat });
    expect(prop.status).toBe(503);
  });
});
