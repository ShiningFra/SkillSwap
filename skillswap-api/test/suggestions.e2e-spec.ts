import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configurerApp } from '../src/app.setup';
import { SmsPort } from '../src/shared/sms';

const ORIGINE = 'http://localhost:3000';
type Membre = { id: string; agent: ReturnType<typeof request.agent> };

describe('Recherche paginée et suggestions classées par pertinence', () => {
  let app: INestApplication;
  let pool: Pool;
  let compteur = 0;

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

  async function membre(): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = `${Date.now()}${compteur++}`;
    const r = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email: `sg${n}@exemple.cm`,
        pseudo: `Sg${n.slice(-8)}`,
        motDePasse: 'un-mot-de-passe-solide',
        majeur: true,
        cgu: true,
      });
    expect(r.status).toBe(201);
    return { id: r.body.id as string, agent };
  }
  const declarer = (m: Membre, competenceId: string, sens: string) =>
    m.agent.post('/moi/competences').set('Origin', ORIGINE).send({
      competenceId,
      sens,
      niveau: 'INTERMEDIAIRE',
      format: 'LES_DEUX',
    });

  it('classe : réciproque, puis offre utile, puis demande ; pagine ; ignore le hors-sujet', async () => {
    const comp = (
      await pool.query(
        `SELECT id FROM competence WHERE libelle IN ('Anglais','Python','Guitare','Couture') ORDER BY libelle`,
      )
    ).rows.map((r) => r.id as string);
    const [anglais, couture, guitare, python] = comp;
    const moi = await membre();
    await declarer(moi, anglais, 'RECHERCHEE');
    await declarer(moi, python, 'OFFERTE');

    const mutuel = await membre();
    await declarer(mutuel, anglais, 'OFFERTE');
    await declarer(mutuel, python, 'RECHERCHEE');
    const offreSeule = await membre();
    await declarer(offreSeule, anglais, 'OFFERTE');
    const demandeSeule = await membre();
    await declarer(demandeSeule, python, 'RECHERCHEE');
    const horsSujet = await membre();
    await declarer(horsSujet, guitare, 'OFFERTE');
    await declarer(horsSujet, couture, 'RECHERCHEE');

    const res = await moi.agent.get('/suggestions?limite=10');
    expect(res.status).toBe(200);
    const ids = res.body.resultats.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(horsSujet.id);
    const rang = (m: Membre) => ids.indexOf(m.id);
    expect(rang(mutuel)).toBeLessThan(rang(offreSeule));
    expect(rang(offreSeule)).toBeLessThan(rang(demandeSeule));
    const raison = (m: Membre) =>
      res.body.resultats.find((r: { id: string }) => r.id === m.id).raison;
    expect([raison(mutuel), raison(offreSeule), raison(demandeSeule)]).toEqual([
      'mutuel',
      'offre',
      'demande',
    ]);
    const m = res.body.resultats.find(
      (r: { id: string }) => r.id === mutuel.id,
    );
    expect(m.offres[0].competenceId).toBe(anglais);
    expect(m.reciproques).toEqual([python]);

    const p1 = await moi.agent.get('/suggestions?limite=1');
    expect(p1.body.resultats).toHaveLength(1);
    expect(p1.body.suite).toBe(true);
    const p2 = await moi.agent.get('/suggestions?limite=1&decalage=1');
    expect(p2.body.resultats[0].id).not.toBe(p1.body.resultats[0].id);
  });

  it('sans rien de déclaré : les membres les plus proches ; recherche multi-compétences', async () => {
    const vide = await membre();
    const res = await vide.agent.get('/suggestions');
    expect(res.status).toBe(200);
    expect(
      res.body.resultats.every(
        (r: { raison: string }) => r.raison === 'proximite',
      ),
    ).toBe(true);
    const comp = (
      await pool.query(
        `SELECT id FROM competence WHERE libelle IN ('Anglais','Python')`,
      )
    ).rows.map((r) => r.id as string);
    const multi = await vide.agent.get(
      `/profils?competenceIds=${comp.join(',')}&limite=50`,
    );
    expect(multi.status).toBe(200);
    expect(multi.body.resultats.length).toBeGreaterThan(0);
    expect(
      (await vide.agent.get('/profils?competenceIds=pas-un-uuid')).status,
    ).toBe(400);
  });

  it('exige une session ouverte', async () => {
    expect(
      (await request(app.getHttpServer()).get('/suggestions')).status,
    ).toBe(401);
  });
});
