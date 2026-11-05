import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import * as webpush from 'web-push';
import { AppModule } from '../src/app.module';
import { configurerApp } from '../src/app.setup';
import { SmsPort } from '../src/shared/sms';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({ statusCode: 201 }),
}));

const ORIGINE = 'http://localhost:3000';
const MDP = 'un-mot-de-passe-solide';
const CLES = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
let compteur = 0;

describe('Notifications sur l\'appareil (Web Push)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.THROTTLE_DISABLED = 'true';
    process.env.VAPID_PUBLIC_KEY = 'BPublique'.padEnd(87, 'x');
    process.env.VAPID_PRIVATE_KEY = 'privee'.padEnd(43, 'y');
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
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    await pool.end();
    await app.close();
  });

  async function membre() {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const res = await agent.post('/auth/inscription').set('Origin', ORIGINE).send({
      email: `push${Date.now()}${n}@exemple.cm`, pseudo: `Push${n}`, motDePasse: MDP, majeur: true, cgu: true,
    });
    expect(res.status).toBe(201);
    return { agent, id: res.body.id as string };
  }
  const abonner = (a: request.Agent, endpoint: string) =>
    a.post('/moi/push').set('Origin', ORIGINE).send({ endpoint, keys: CLES });
  const attendre = async (cond: () => boolean) => {
    for (let i = 0; i < 40 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
  };

  it('exige une session et expose la clé publique', async () => {
    expect((await request(app.getHttpServer()).get('/push/cle')).status).toBe(401);
    const m = await membre();
    const r = await m.agent.get('/push/cle');
    expect(r.status).toBe(200);
    expect(r.body.cle).toContain('BPublique');
  });

  it('refuse un endpoint qui ne vient pas d\'un service de push connu (SSRF)', async () => {
    const m = await membre();
    for (const e of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://exemple.com/push', 'https://fcm.googleapis.com.evil.com/x', 'pas une url'])
      expect((await abonner(m.agent, e)).status).toBe(400);
  });

  it('envoie un push générique à chaque appareil du destinataire, et retire un appareil mort', async () => {
    const m = await membre();
    const envoi = webpush.sendNotification as jest.Mock;
    envoi.mockClear();
    expect((await abonner(m.agent, 'https://fcm.googleapis.com/fcm/send/vivant')).status).toBe(204);
    expect((await abonner(m.agent, 'https://fcm.googleapis.com/fcm/send/mort')).status).toBe(204);
    envoi.mockImplementation((s: { endpoint: string }) =>
      s.endpoint.endsWith('/mort') ? Promise.reject({ statusCode: 410 }) : Promise.resolve({ statusCode: 201 }));
    await pool.query(`INSERT INTO notification (utilisateur_id, type, contenu, lien) VALUES ($1, 'NOUVEAU_MESSAGE', 'Texte privé', '/messages/abc')`, [m.id]);
    await attendre(() => envoi.mock.calls.length >= 2);
    expect(envoi).toHaveBeenCalledTimes(2);
    const charge = JSON.parse(envoi.mock.calls[0][1] as string);
    expect(charge.corps).toBe('Tu as un nouveau message');
    expect(JSON.stringify(charge)).not.toContain('Texte privé');
    expect(charge.lien).toBe('/messages/abc');
    await attendre(() => false || true);
    await new Promise((r) => setTimeout(r, 300));
    const restants = await pool.query(`SELECT endpoint FROM push_abonnement WHERE utilisateur_id = $1`, [m.id]);
    expect(restants.rows.map((r) => r.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/vivant']);
    envoi.mockReset(); envoi.mockResolvedValue({ statusCode: 201 });
  });

  it('un membre ne reçoit que ses propres pushs, et le retrait fonctionne', async () => {
    const a = await membre();
    const b = await membre();
    const envoi = webpush.sendNotification as jest.Mock;
    envoi.mockClear();
    await abonner(a.agent, 'https://updates.push.services.mozilla.com/wpush/v2/a');
    await pool.query(`INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, 'NOUVEAU_MESSAGE', 'x')`, [b.id]);
    await new Promise((r) => setTimeout(r, 500));
    expect(envoi).not.toHaveBeenCalled();
    expect((await a.agent.post('/moi/push/retirer').set('Origin', ORIGINE).send({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/a' })).status).toBe(204);
    expect((await pool.query(`SELECT 1 FROM push_abonnement WHERE utilisateur_id = $1`, [a.id])).rowCount).toBe(0);
  });
});
