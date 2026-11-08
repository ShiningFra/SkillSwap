import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SMTPServer } from 'smtp-server';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configurerApp } from '../src/app.setup';
import { MailPort, MailSmtpOuConsole } from '../src/shared/mail';
import { SmsPort } from '../src/shared/sms';

const ORIGINE = 'http://localhost:3000';
const MDP = 'un-mot-de-passe-solide';
let compteur = 0;

describe('Mot de passe oublié', () => {
  let app: INestApplication;
  let pool: Pool;
  const envoyes: { a: string; sujet: string; texte: string }[] = [];

  beforeAll(async () => {
    process.env.THROTTLE_DISABLED = 'true';
    app = (
      await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SmsPort)
        .useValue({ envoyerCode: async () => undefined })
        .overrideProvider(MailPort)
        .useValue({
          envoyer: (a: string, sujet: string, texte: string) => {
            envoyes.push({ a, sujet, texte });
            return Promise.resolve();
          },
        })
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

  async function compte() {
    const n = ++compteur;
    const email = `oubli${Date.now()}${n}@exemple.cm`;
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email,
        pseudo: `Oubli${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    return { email, agent, id: res.body.id as string };
  }
  const demander = (email: string) =>
    request(app.getHttpServer())
      .post('/auth/mot-de-passe-oublie')
      .set('Origin', ORIGINE)
      .send({ email });
  const reinit = (jeton: string, nouveau: string) =>
    request(app.getHttpServer())
      .post('/auth/reinitialisation')
      .set('Origin', ORIGINE)
      .send({ jeton, nouveau });
  const jetonDe = (email: string) => {
    const m = [...envoyes].reverse().find((x) => x.a === email);
    return /reinitialisation\?jeton=([\w-]+)/.exec(m?.texte ?? '')?.[1] ?? '';
  };
  const attendre = () => new Promise((r) => setTimeout(r, 50));

  it('répond pareil pour une adresse inconnue et n’envoie rien', async () => {
    const avant = envoyes.length;
    const res = await demander('inconnu@exemple.cm');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    await attendre();
    expect(envoyes.length).toBe(avant);
  });

  it('réinitialise avec le lien reçu, une seule fois, et révoque les sessions', async () => {
    const c = await compte();
    expect((await demander(c.email)).status).toBe(202);
    await attendre();
    const jeton = jetonDe(c.email);
    expect(jeton.length).toBeGreaterThan(30);
    expect(envoyes.at(-1)?.texte).toContain(
      'http://localhost:3000/reinitialisation?jeton=',
    );
    // le jeton n'est jamais stocké en clair
    const stocke = await pool.query(
      `SELECT jeton_hash FROM reinitialisation_mdp WHERE utilisateur_id = $1`,
      [c.id],
    );
    expect(stocke.rows[0].jeton_hash).not.toContain(jeton);

    expect((await reinit(jeton, 'court')).status).toBe(400);
    expect(
      (await reinit('x'.repeat(43), 'un-nouveau-mot-de-passe')).status,
    ).toBe(400);
    expect((await reinit(jeton, 'un-nouveau-mot-de-passe')).status).toBe(204);
    expect((await reinit(jeton, 'encore-un-autre-mdp-1')).status).toBe(400);
    expect((await c.agent.get('/moi')).status).toBe(401);
    const vieux = await request(app.getHttpServer())
      .post('/auth/connexion')
      .set('Origin', ORIGINE)
      .send({ email: c.email, motDePasse: MDP });
    expect(vieux.status).toBe(401);
    const neuf = await request(app.getHttpServer())
      .post('/auth/connexion')
      .set('Origin', ORIGINE)
      .send({ email: c.email, motDePasse: 'un-nouveau-mot-de-passe' });
    expect(neuf.status).toBe(200);
  });

  it('une nouvelle demande invalide l’ancien lien ; un lien expiré est refusé', async () => {
    const c = await compte();
    await demander(c.email);
    await attendre();
    const premier = jetonDe(c.email);
    await demander(c.email);
    await attendre();
    const second = jetonDe(c.email);
    expect(second).not.toBe(premier);
    expect((await reinit(premier, 'un-nouveau-mot-de-passe')).status).toBe(400);
    await pool.query(
      `UPDATE reinitialisation_mdp SET expire_le = now() - interval '1 minute', cree_le = now() - interval '2 minutes' WHERE utilisateur_id = $1 AND utilise_le IS NULL`,
      [c.id],
    );
    expect((await reinit(second, 'un-nouveau-mot-de-passe')).status).toBe(400);
  });

  it('limite à 3 demandes par heure par compte, sans signal', async () => {
    const c = await compte();
    for (let i = 0; i < 5; i++)
      expect((await demander(c.email)).status).toBe(202);
    await attendre();
    expect(envoyes.filter((m) => m.a === c.email)).toHaveLength(3);
  });

  it('un compte suspendu ou supprimé ne reçoit rien', async () => {
    const c = await compte();
    await pool.query(
      `UPDATE utilisateur SET statut = 'SUSPENDU' WHERE id = $1`,
      [c.id],
    );
    await demander(c.email);
    await attendre();
    expect(envoyes.some((m) => m.a === c.email)).toBe(false);
  });

  it('envoie réellement par SMTP quand SMTP_URL est défini', async () => {
    const recus: string[] = [];
    const serveur = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(flux, _session, fin) {
        let tampon = '';
        flux.on('data', (d: Buffer) => (tampon += d.toString()));
        flux.on('end', () => {
          recus.push(tampon);
          fin();
        });
      },
    });
    await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
    const port = (serveur.server.address() as { port: number }).port;
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    process.env.MAIL_EXPEDITEUR = 'SkillSwap <test@skillswap.cm>';
    try {
      await new MailSmtpOuConsole().envoyer(
        'membre@exemple.cm',
        'Sujet de test',
        'Corps https://exemple.cm/lien',
      );
      expect(recus).toHaveLength(1);
      expect(recus[0]).toContain('Subject: Sujet de test');
      expect(recus[0]).toContain('https://exemple.cm/lien');
    } finally {
      delete process.env.SMTP_URL;
      delete process.env.MAIL_EXPEDITEUR;
      await new Promise<void>((r) => serveur.close(() => r()));
    }
  });
});
