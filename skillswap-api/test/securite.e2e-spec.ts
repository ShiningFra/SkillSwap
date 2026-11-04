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
const nouvelEmail = () => `membre${Date.now()}${++compteur}@exemple.cm`;

/** Double de test : retient le dernier code « envoyé » par SMS. */
const sms = {
  dernier: '',
  numero: '',
  envoyerCode: async (n: string, c: string) =>
    void ((sms.numero = n), (sms.dernier = c)),
};

async function creerApp(limiter: boolean) {
  process.env.THROTTLE_DISABLED = limiter ? 'false' : 'true';
  const app = (
    await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsPort)
      .useValue(sms)
      .compile()
  ).createNestApplication();
  configurerApp(app);
  await app.init();
  return app;
}

describe("Sécurité de l'API (ES1 à ES13)", () => {
  let app: INestApplication;
  let pool: Pool;
  const http = () => request(app.getHttpServer());

  /** Inscrit un membre et renvoie un agent qui garde son cookie de session. */
  async function membre() {
    const agent = request.agent(app.getHttpServer());
    const email = nouvelEmail();
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email,
        pseudo: 'Amina',
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(
      ';',
    )[0];
    return { agent, email, id: res.body.id as string, cookie };
  }
  const post = (a: request.Agent, url: string, corps: object) =>
    a.post(url).set('Origin', ORIGINE).send(corps);

  beforeAll(async () => {
    app = await creerApp(false);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe('ES2 mots de passe', () => {
    it('stocke un hash argon2id, jamais le mot de passe', async () => {
      const { email } = await membre();
      const { rows } = await pool.query(
        'SELECT mot_de_passe_hash FROM utilisateur WHERE lower(email) = lower($1)',
        [email],
      );
      expect(rows[0].mot_de_passe_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0].mot_de_passe_hash).not.toContain(MDP);
    });
    it('refuse un mot de passe de moins de 10 caractères avec une clé de traduction', async () => {
      const res = await post(
        request.agent(app.getHttpServer()),
        '/auth/inscription',
        {
          email: nouvelEmail(),
          pseudo: 'Ab',
          motDePasse: 'court',
          majeur: true,
          cgu: true,
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.champs.motDePasse).toBe('errors.motDePasse');
    });
  });

  describe('ES3 connexion', () => {
    it('répond de la même façon pour un e-mail inconnu et un mauvais mot de passe', async () => {
      const { email } = await membre();
      const a = await post(
        request.agent(app.getHttpServer()),
        '/auth/connexion',
        { email, motDePasse: 'faux-faux-faux' },
      );
      const b = await post(
        request.agent(app.getHttpServer()),
        '/auth/connexion',
        { email: 'inconnu@exemple.cm', motDePasse: 'faux-faux-faux' },
      );
      expect(a.status).toBe(401);
      expect([b.status, b.body]).toEqual([a.status, a.body]);
    });
    it('bloque le compte après 5 échecs, même avec le bon mot de passe', async () => {
      const { email } = await membre();
      for (let i = 0; i < 5; i++)
        await post(request.agent(app.getHttpServer()), '/auth/connexion', {
          email,
          motDePasse: 'faux-faux-faux',
        });
      const res = await post(
        request.agent(app.getHttpServer()),
        '/auth/connexion',
        { email, motDePasse: MDP },
      );
      expect(res.status).toBe(429);
    });
    it("accepte le bon mot de passe quand le compte n'est pas bloqué", async () => {
      const { email } = await membre();
      const res = await post(
        request.agent(app.getHttpServer()),
        '/auth/connexion',
        { email: email.toUpperCase(), motDePasse: MDP },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('ES4 session et CSRF', () => {
    it("pose un cookie HttpOnly et SameSite=Lax, et ne stocke que l'empreinte du jeton", async () => {
      const res = await post(
        request.agent(app.getHttpServer()),
        '/auth/inscription',
        {
          email: nouvelEmail(),
          pseudo: 'Kevin',
          motDePasse: MDP,
          majeur: true,
          cgu: true,
        },
      );
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^sid=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      const jeton = cookie.split(';')[0].slice(4);
      const { rows } = await pool.query(
        'SELECT jeton_hash FROM session_connexion WHERE jeton_hash = $1',
        [jeton],
      );
      expect(rows).toHaveLength(0); // le jeton lui-même n'est pas en base
    });
    it("refuse /moi sans session, et après déconnexion même avec l'ancien cookie", async () => {
      expect((await http().get('/moi')).status).toBe(401);
      const { agent, cookie } = await membre();
      expect((await agent.get('/moi')).status).toBe(200);
      expect((await post(agent, '/auth/deconnexion', {})).status).toBe(204);
      expect((await agent.get('/moi')).status).toBe(401);
      // L'ancien jeton, rejoué à la main, doit rester refusé : la révocation est côté serveur.
      expect((await http().get('/moi').set('Cookie', cookie)).status).toBe(401);
    });
    it("refuse une modification venue d'une autre origine", async () => {
      const { agent } = await membre();
      const res = await agent
        .put('/moi/localisation')
        .set('Origin', 'https://site-pirate.example')
        .send({ mode: 'AUCUNE' });
      expect(res.status).toBe(403);
    });
    it('refuse un envoi de formulaire classique', async () => {
      const { agent } = await membre();
      const res = await agent
        .put('/moi/localisation')
        .set('Origin', ORIGINE)
        .type('form')
        .send('mode=AUCUNE');
      expect(res.status).toBe(415);
    });
  });

  describe('ES5 code SMS (RG17)', () => {
    it('vérifie le numéro avec le bon code, sans stocker le code', async () => {
      const { agent, id } = await membre();
      expect(
        (await post(agent, '/telephone/code', { telephone: '+237670000001' }))
          .status,
      ).toBe(202);
      const { rows } = await pool.query(
        'SELECT code_hash FROM verification_telephone WHERE utilisateur_id = $1',
        [id],
      );
      expect(rows[0].code_hash).not.toContain(sms.dernier);
      expect(rows[0].code_hash).toHaveLength(64);
      expect(
        (await post(agent, '/telephone/verifier', { code: sms.dernier }))
          .status,
      ).toBe(200);
      expect((await agent.get('/moi')).body.telephoneVerifie).toBe(true);
    });
    it('invalide le code après 5 essais ratés, même si le bon code arrive ensuite', async () => {
      const { agent } = await membre();
      await post(agent, '/telephone/code', { telephone: '+237670000002' });
      const bon = sms.dernier;
      const faux = bon === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++)
        expect(
          (await post(agent, '/telephone/verifier', { code: faux })).status,
        ).toBe(400);
      expect(
        (await post(agent, '/telephone/verifier', { code: bon })).status,
      ).toBe(400);
      expect((await agent.get('/moi')).body.telephoneVerifie).toBe(false);
    });
    it('refuse un code expiré', async () => {
      const { agent, id } = await membre();
      await post(agent, '/telephone/code', { telephone: '+237670000003' });
      await pool.query(
        `UPDATE verification_telephone SET cree_le = now() - interval '20 minutes', expire_le = now() - interval '10 minutes' WHERE utilisateur_id = $1`,
        [id],
      );
      expect(
        (await post(agent, '/telephone/verifier', { code: sms.dernier }))
          .status,
      ).toBe(400);
    });
    it('plafonne à 3 envois par heure et par membre', async () => {
      const { agent } = await membre();
      for (let i = 0; i < 3; i++)
        expect(
          (await post(agent, '/telephone/code', { telephone: '+237670000004' }))
            .status,
        ).toBe(202);
      expect(
        (await post(agent, '/telephone/code', { telephone: '+237670000004' }))
          .status,
      ).toBe(429);
    });
    it('refuse un numéro déjà vérifié par un autre compte', async () => {
      const a = await membre();
      await post(a.agent, '/telephone/code', { telephone: '+237670000005' });
      await post(a.agent, '/telephone/verifier', { code: sms.dernier });
      const b = await membre();
      await post(b.agent, '/telephone/code', { telephone: '+237670000005' });
      expect(
        (await post(b.agent, '/telephone/verifier', { code: sms.dernier }))
          .status,
      ).toBe(409);
    });
    it('refuse un numéro mal formé', async () => {
      const { agent } = await membre();
      expect(
        (await post(agent, '/telephone/code', { telephone: '0670000000' }))
          .status,
      ).toBe(400);
    });
  });

  describe("ES6 contrôle d'accès", () => {
    it('refuse toutes les routes protégées sans session', async () => {
      for (const [m, u] of [
        ['get', '/moi/competences'],
        ['post', '/moi/competences'],
        ['put', '/moi/localisation'],
        ['post', '/telephone/code'],
        ['post', '/telephone/verifier'],
      ] as const) {
        const res = await (
          http() as unknown as Record<string, (u: string) => request.Test>
        )
          [m](u)
          .set('Origin', ORIGINE)
          .send({});
        expect([m, u, res.status]).toEqual([m, u, 401]);
      }
    });
    it("empêche un membre de voir ou retirer la déclaration d'un autre", async () => {
      const a = await membre();
      const b = await membre();
      const catalogue = (await http().get('/competences')).body as {
        id: string;
      }[];
      const competenceId = catalogue[0].id;
      expect(
        (
          await post(a.agent, '/moi/competences', {
            competenceId,
            sens: 'OFFERTE',
            niveau: 'AVANCE',
            format: 'DISTANCE',
          })
        ).status,
      ).toBe(201);
      expect((await b.agent.get('/moi/competences')).body).toEqual([]);
      const res = await b.agent
        .delete(`/moi/competences/${competenceId}`)
        .set('Origin', ORIGINE);
      expect(res.status).toBe(404);
      expect((await a.agent.get('/moi/competences')).body).toHaveLength(1);
    });
  });

  describe('compétences (RG3, RG18)', () => {
    it('refuse une déclaration en double, un lien dangereux et une preuve sur une compétence recherchée', async () => {
      const { agent } = await membre();
      const [c1, c2] = (
        (await http().get('/competences')).body as { id: string }[]
      ).map((c) => c.id);
      const base = {
        competenceId: c1,
        sens: 'OFFERTE',
        niveau: 'AVANCE',
        format: 'DISTANCE',
      };
      expect((await post(agent, '/moi/competences', base)).status).toBe(201);
      expect((await post(agent, '/moi/competences', base)).body.cle).toBe(
        'errors.dejaDeclaree',
      );
      expect(
        (
          await post(agent, '/moi/competences', {
            ...base,
            competenceId: c2,
            preuveUrl: 'javascript:alert(1)',
          })
        ).status,
      ).toBe(400);
      const res = await post(agent, '/moi/competences', {
        ...base,
        competenceId: c2,
        sens: 'RECHERCHEE',
        preuveUrl: 'https://exemple.com/a',
      });
      expect(res.body.champs.preuveUrl).toBe('errors.preuveSeulementOfferte');
    });
  });

  describe('ES8 localisation (RG5)', () => {
    it('ne renvoie jamais les coordonnées et les efface au changement de mode', async () => {
      const { agent, id } = await membre();
      expect((await post(agent, '/moi/localisation', {})).status).toBe(404); // la route est un PUT
      const put = (corps: object) =>
        agent.put('/moi/localisation').set('Origin', ORIGINE).send(corps);
      expect(
        (
          await put({
            mode: 'AUTOMATIQUE',
            latitude: 3.8667,
            longitude: 11.5167,
          })
        ).status,
      ).toBe(400); // sans consentement
      expect(
        (
          await put({
            mode: 'AUTOMATIQUE',
            consentement: true,
            latitude: 3.8667,
            longitude: 11.5167,
          })
        ).status,
      ).toBe(204);
      const moi = (await agent.get('/moi')).body;
      expect(JSON.stringify(moi)).not.toMatch(
        /3\.86|11\.51|latitude|longitude/,
      );
      expect(
        (
          await pool.query('SELECT latitude FROM utilisateur WHERE id = $1', [
            id,
          ])
        ).rows[0].latitude,
      ).not.toBeNull();
      expect((await put({ mode: 'MANUELLE', ville: 'Yaoundé' })).status).toBe(
        204,
      );
      const apres = (
        await pool.query(
          'SELECT latitude, longitude FROM utilisateur WHERE id = $1',
          [id],
        )
      ).rows[0];
      expect(apres).toEqual({ latitude: null, longitude: null });
      const consent = await pool.query(
        `SELECT revoque_le FROM consentement WHERE utilisateur_id = $1 AND finalite = 'LOCALISATION'`,
        [id],
      );
      expect(consent.rows[0].revoque_le).not.toBeNull();
    });
    it('refuse des coordonnées hors bornes', async () => {
      const { agent } = await membre();
      const res = await agent
        .put('/moi/localisation')
        .set('Origin', ORIGINE)
        .send({
          mode: 'AUTOMATIQUE',
          consentement: true,
          latitude: 200,
          longitude: 0,
        });
      expect(res.status).toBe(400);
    });
  });

  describe('ES7 entrées hostiles', () => {
    it("refuse un pseudo piégé et traite l'injection SQL comme du texte ailleurs", async () => {
      const piege = "'); DROP TABLE utilisateur;--";
      const refus = await post(
        request.agent(app.getHttpServer()),
        '/auth/inscription',
        {
          email: nouvelEmail(),
          pseudo: '<img src=x onerror=alert(1)>',
          motDePasse: MDP,
          majeur: true,
          cgu: true,
        },
      );
      expect(refus.status).toBe(400);
      const agent = request.agent(app.getHttpServer());
      const res = await post(agent, '/auth/inscription', {
        email: nouvelEmail(),
        pseudo: 'Pseudo ordinaire',
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
      expect(res.status).toBe(201);
      await agent
        .put('/moi/profil')
        .set('Origin', ORIGINE)
        .send({ pseudo: 'Pseudo ordinaire', bio: piege })
        .expect(204);
      expect(
        (
          await pool.query('SELECT bio FROM utilisateur WHERE id = $1', [
            res.body.id,
          ])
        ).rows[0].bio,
      ).toBe(piege);
      const connexion = await post(
        request.agent(app.getHttpServer()),
        '/auth/connexion',
        { email: "' OR 1=1 --", motDePasse: "' OR '1'='1" },
      );
      expect(connexion.status).toBe(401);
    });
    it("refuse un corps qui n'est pas un objet attendu", async () => {
      const res = await post(
        request.agent(app.getHttpServer()),
        '/auth/inscription',
        { email: { $ne: null }, pseudo: 'x' },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('ES1 et ES11 en-têtes et CORS', () => {
    it('envoie HSTS, CSP, nosniff et ne révèle pas le serveur', async () => {
      const res = await http().get('/competences');
      expect(res.headers['strict-transport-security']).toMatch(
        /max-age=63072000/,
      );
      expect(res.headers['content-security-policy']).toMatch(
        /default-src 'none'/,
      );
      expect(res.headers['content-security-policy']).toMatch(
        /frame-ancestors 'none'/,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
    it("n'autorise CORS que pour l'origine du site", async () => {
      const bon = await http()
        .options('/moi')
        .set('Origin', ORIGINE)
        .set('Access-Control-Request-Method', 'GET');
      expect(bon.headers['access-control-allow-origin']).toBe(ORIGINE);
      const mauvais = await http()
        .options('/moi')
        .set('Origin', 'https://site-pirate.example')
        .set('Access-Control-Request-Method', 'GET');
      // Le serveur n'annonce que l'origine du site ; le navigateur bloque donc toute autre origine.
      expect(mauvais.headers['access-control-allow-origin']).not.toBe(
        'https://site-pirate.example',
      );
    });
  });

  describe("ES10 journal d'audit", () => {
    it('enregistre les actions sensibles sans donnée sensible', async () => {
      const { agent, id } = await membre();
      await post(agent, '/telephone/code', { telephone: '+237670000099' });
      const code = sms.dernier;
      await post(agent, '/telephone/verifier', { code });
      await agent.put('/moi/localisation').set('Origin', ORIGINE).send({
        mode: 'AUTOMATIQUE',
        consentement: true,
        latitude: 4.0511,
        longitude: 9.7679,
      });
      const { rows } = await pool.query(
        'SELECT action, cible, detail FROM journal_audit WHERE acteur_id = $1 ORDER BY cree_le',
        [id],
      );
      expect(rows.map((r) => r.action)).toEqual([
        'TELEPHONE_VERIFIE',
        'LOCALISATION_MODIFIEE',
      ]);
      const texte = JSON.stringify(rows);
      for (const secret of [MDP, code, '4.0511', '9.7679', '670000099'])
        expect(texte).not.toContain(secret);
    });
    it("ne conserve pas l'e-mail dans les tentatives de connexion", async () => {
      const { email } = await membre();
      await post(request.agent(app.getHttpServer()), '/auth/connexion', {
        email,
        motDePasse: 'faux-faux-faux',
      });
      const { rows } = await pool.query(
        'SELECT email_hash FROM tentative_connexion ORDER BY cree_le DESC LIMIT 1',
      );
      expect(rows[0].email_hash).toHaveLength(64);
      expect(JSON.stringify(rows)).not.toContain(email.toLowerCase());
    });
  });
});

describe('ES13 limitation de débit', () => {
  it('répond 429 au-delà de 10 inscriptions par minute et par IP', async () => {
    const app = await creerApp(true);
    try {
      const statuts: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/inscription')
          .set('Origin', ORIGINE)
          .send({});
        statuts.push(res.status);
      }
      expect(statuts.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(statuts.slice(10)).toEqual([429, 429]);
    } finally {
      await app.close();
    }
  });
});
