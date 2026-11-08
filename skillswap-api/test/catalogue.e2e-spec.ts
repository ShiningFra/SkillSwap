import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configurerApp } from '../src/app.setup';
import { SmsPort } from '../src/shared/sms';

const ORIGINE = 'http://localhost:3000';

describe('Catalogue : synonymes et propositions de compétences', () => {
  let app: INestApplication;
  let pool: Pool;
  const agent = () => request.agent(app.getHttpServer());

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

  it('le catalogue est large et expose les synonymes', async () => {
    const res = await request(app.getHttpServer()).get('/competences');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(100);
    const maths = res.body.find(
      (c: { libelle: string }) => c.libelle === 'Mathématiques',
    );
    expect(maths.synonymes).toContain('maths');
  });

  it('refuse sans session, puis propose, détecte les doublons et limite', async () => {
    const anonyme = await request(app.getHttpServer())
      .post('/competences')
      .set('Origin', ORIGINE)
      .send({ libelle: 'Zythologie', categorieId: 'x' });
    expect(anonyme.status).toBe(401);

    const a = agent();
    const email = `cat${Date.now()}@exemple.cm`;
    const ins = await a
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email,
        pseudo: `Cat${Date.now() % 100000}`,
        motDePasse: 'un-mot-de-passe-solide',
        majeur: true,
        cgu: true,
      });
    expect(ins.status).toBe(201);
    const cat = (await pool.query('SELECT id FROM categorie LIMIT 1')).rows[0]
      .id;

    const dup = await a
      .post('/competences')
      .set('Origin', ORIGINE)
      .send({ libelle: ' MATHS ', categorieId: cat });
    expect(dup.status).toBe(201);
    expect(dup.body.existait).toBe(true);
    expect(dup.body.libelle).toBe('Mathématiques');

    const nom = `Zythologie ${Date.now()}`;
    const neuve = await a
      .post('/competences')
      .set('Origin', ORIGINE)
      .send({ libelle: nom, categorieId: cat });
    expect(neuve.body.existait).toBe(false);
    const encore = await a
      .post('/competences')
      .set('Origin', ORIGINE)
      .send({ libelle: nom.toUpperCase(), categorieId: cat });
    expect(encore.body.existait).toBe(true);
    expect(encore.body.id).toBe(neuve.body.id);

    for (let i = 0; i < 4; i++)
      await a
        .post('/competences')
        .set('Origin', ORIGINE)
        .send({
          libelle: `Compétence rare ${Date.now()} ${i}`,
          categorieId: cat,
        });
    const trop = await a
      .post('/competences')
      .set('Origin', ORIGINE)
      .send({ libelle: `Une de trop ${Date.now()}`, categorieId: cat });
    expect(trop.status).toBe(429);
  });

  it('recherche par le sens : répond toujours, liste vide quand la fonction est coupée', async () => {
    // Le modèle lui-même est vérifié hors Jest (l'import ESM dynamique y est restreint).
    const res = await request(app.getHttpServer()).get(
      '/competences/proches?q=' + encodeURIComponent('faire des gâteaux'),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
