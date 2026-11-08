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

describe('Portefeuille : recharge, séquestre, libération, remboursement, arbitrage', () => {
  let app: INestApplication;
  let pool: Pool;
  let competence: string;

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
    competence = (await pool.query('SELECT id FROM competence LIMIT 1')).rows[0]
      .id;
  });
  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  type Membre = { agent: request.Agent; id: string };
  const post = (m: Membre, url: string, corps: object = {}) =>
    m.agent.post(url).set('Origin', ORIGINE).send(corps);
  const get = (m: Membre, url: string) => m.agent.get(url);

  async function membre(admin = false): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email: `pf${Date.now()}${n}@exemple.cm`,
        pseudo: `Porte${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    await pool.query(
      `UPDATE utilisateur SET telephone = $2, telephone_verifie_le = now(), role = $3 WHERE id = $1`,
      [
        res.body.id,
        `+2376${String(Date.now()).slice(-6)}${n % 10}${n % 7}`,
        admin ? 'ADMIN' : 'MEMBRE',
      ],
    );
    return { agent, id: res.body.id };
  }

  async function recharger(m: Membre, montant: number) {
    const r = await post(m, '/portefeuille/recharges', {
      montant,
      operateur: 'MTN',
      numero: '677 12 34 56',
    });
    expect(r.status).toBe(201);
    const s = await post(
      m,
      `/portefeuille/recharges/${r.body.reference}/simulation`,
      { issue: 'REUSSIE' },
    );
    expect(s.status).toBe(204);
    return r.body.reference as string;
  }
  const solde = async (m: Membre) => (await get(m, '/portefeuille')).body;

  let decalage = 20;
  /** Un élève avec `argent` FCFA, un professeur, une session payante proposée au prix `prix`. */
  async function scenario(argent: number, prix = 2000) {
    const prof = await membre();
    const eleve = await membre();
    if (argent) await recharger(eleve, argent);
    await pool.query(
      `INSERT INTO declaration_competence (utilisateur_id, competence_id, sens, niveau, format) VALUES ($1, $2, 'OFFERTE', 'AVANCE', 'LES_DEUX')`,
      [prof.id, competence],
    );
    const conv = (await post(eleve, '/conversations', { membreId: prof.id }))
      .body.id;
    decalage += 3;
    const debut = new Date(Date.now() + decalage * 86_400_000);
    const k = (
      await post(prof, '/moi/creneaux', {
        debut: debut.toISOString(),
        fin: new Date(+debut + 3_600_000).toISOString(),
        format: 'LES_DEUX',
      })
    ).body.id;
    const s = await post(eleve, `/conversations/${conv}/sessions`, {
      creneauId: k,
      format: 'DISTANCE',
      contrepartie: 'ARGENT_PLATEFORME',
      prix,
    });
    return { prof, eleve, s, id: s.body?.id as string };
  }
  const passerLaDate = (id: string) =>
    pool.query(
      `UPDATE session_echange SET date_heure = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );

  describe('recharge et retrait', () => {
    it('crédite une fois, même si le résultat est notifié deux fois (idempotence)', async () => {
      const m = await membre();
      const ref = await recharger(m, 5000);
      await post(m, `/portefeuille/recharges/${ref}/simulation`, {
        issue: 'REUSSIE',
      });
      expect((await solde(m)).disponible).toBe(5000);
      const h = await get(m, '/portefeuille/historique');
      expect(h.body.ecritures).toHaveLength(1);
      expect(h.body.ecritures[0].type).toBe('RECHARGE');
    });

    it('ne crédite rien si le paiement échoue, et ne garde pas le numéro complet', async () => {
      const m = await membre();
      const r = await post(m, '/portefeuille/recharges', {
        montant: 3000,
        operateur: 'ORANGE',
        numero: '+237699887766',
      });
      await post(m, `/portefeuille/recharges/${r.body.reference}/simulation`, {
        issue: 'ECHOUEE',
      });
      expect((await solde(m)).disponible).toBe(0);
      const t = await pool.query(
        'SELECT numero_masque, statut FROM transaction_externe WHERE utilisateur_id = $1',
        [m.id],
      );
      expect(t.rows[0].statut).toBe('ECHOUEE');
      expect(t.rows[0].numero_masque).not.toContain('887766');
    });

    it('valide montants et numéros, un seul paiement en cours, plafond du solde', async () => {
      const m = await membre();
      const mauvais = [
        { montant: 100, operateur: 'MTN', numero: '677123456' },
        { montant: 2000.5, operateur: 'MTN', numero: '677123456' },
        { montant: 2000, operateur: 'AUTRE', numero: '677123456' },
        { montant: 2000, operateur: 'MTN', numero: '12345' },
      ];
      for (const c of mauvais)
        expect((await post(m, '/portefeuille/recharges', c)).status).toBe(400);
      const ok = { montant: 2000, operateur: 'MTN', numero: '677123456' };
      expect((await post(m, '/portefeuille/recharges', ok)).status).toBe(201);
      expect((await post(m, '/portefeuille/recharges', ok)).status).toBe(409);
      await pool.query(
        `UPDATE transaction_externe SET statut = 'ECHOUEE' WHERE utilisateur_id = $1`,
        [m.id],
      );
      // Gros solde obtenu par une vraie recharge réussie, pour que le grand livre reste cohérent.
      const tx = await pool.query(
        `INSERT INTO transaction_externe (utilisateur_id, sens, montant, operateur, statut, reference)
         VALUES ($1, 'RECHARGE', 499000, 'MTN', 'REUSSIE', $2) RETURNING id`,
        [m.id, `TEST-${m.id}`],
      );
      await pool.query(
        `INSERT INTO portefeuille (utilisateur_id, disponible) VALUES ($1, 499000)`,
        [m.id],
      );
      await pool.query(
        `INSERT INTO ecriture_portefeuille (utilisateur_id, type, delta_disponible, transaction_id) VALUES ($1, 'RECHARGE', 499000, $2)`,
        [m.id, tx.rows[0].id],
      );
      expect((await post(m, '/portefeuille/recharges', ok)).status).toBe(409);
    });

    it("n'accepte la simulation que de son propriétaire", async () => {
      const a = await membre();
      const b = await membre();
      const r = await post(a, '/portefeuille/recharges', {
        montant: 2000,
        operateur: 'MTN',
        numero: '677123456',
      });
      const s = await post(
        b,
        `/portefeuille/recharges/${r.body.reference}/simulation`,
        { issue: 'REUSSIE' },
      );
      expect(s.status).toBe(404);
      expect((await solde(a)).disponible).toBe(0);
    });

    it('retire vers Mobile Money avec mot de passe, jamais au-delà du solde', async () => {
      const m = await membre();
      await recharger(m, 4000);
      const corps = { montant: 1500, operateur: 'MTN', numero: '677123456' };
      expect(
        (await post(m, '/portefeuille/retraits', { ...corps, motDePasse: 'x' }))
          .status,
      ).toBe(401);
      expect(
        (
          await post(m, '/portefeuille/retraits', {
            ...corps,
            montant: 9000,
            motDePasse: MDP,
          })
        ).status,
      ).toBe(409);
      expect(
        (await post(m, '/portefeuille/retraits', { ...corps, motDePasse: MDP }))
          .status,
      ).toBe(204);
      expect((await solde(m)).disponible).toBe(2500);
    });

    it('est refusé quand le portefeuille est en révision', async () => {
      const admin = await membre(true);
      const m = await membre();
      const corps = { montant: 2000, operateur: 'MTN', numero: '677123456' };
      await admin.agent
        .put('/admin/parametres/portefeuille')
        .set('Origin', ORIGINE)
        .send({ actif: false, motDePasse: MDP });
      try {
        const r = await post(m, '/portefeuille/recharges', corps);
        expect(r.status).toBe(503);
      } finally {
        await admin.agent
          .put('/admin/parametres/portefeuille')
          .set('Origin', ORIGINE)
          .send({ actif: true, motDePasse: MDP });
      }
    });
  });

  describe('séquestre', () => {
    it('refuse une proposition payante sans prix ou sans solde suffisant', async () => {
      const sans = await scenario(0, 2000);
      expect(sans.s.status).toBe(409);
      const prof = await membre();
      const eleve = await membre();
      await pool.query(
        `INSERT INTO declaration_competence (utilisateur_id, competence_id, sens, niveau, format) VALUES ($1, $2, 'OFFERTE', 'AVANCE', 'LES_DEUX')`,
        [prof.id, competence],
      );
      const conv = (await post(eleve, '/conversations', { membreId: prof.id }))
        .body.id;
      const debut = new Date(Date.now() + 90 * 86_400_000);
      const k = (
        await post(prof, '/moi/creneaux', {
          debut: debut.toISOString(),
          fin: new Date(+debut + 3_600_000).toISOString(),
          format: 'LES_DEUX',
        })
      ).body.id;
      const r = await post(eleve, `/conversations/${conv}/sessions`, {
        creneauId: k,
        format: 'DISTANCE',
        contrepartie: 'ARGENT_PLATEFORME',
      });
      expect(r.status).toBe(400);
    });

    it("bloque le prix à l'acceptation, le verse après les deux confirmations", async () => {
      const { prof, eleve, id, s } = await scenario(5000, 2000);
      expect(s.status).toBe(201);
      expect((await solde(eleve)).disponible).toBe(5000);
      const acc = await post(prof, `/sessions/${id}/reponse`, {
        accepter: true,
      });
      expect(acc.status).toBe(204);
      expect(await solde(eleve)).toMatchObject({
        disponible: 3000,
        sequestre: 2000,
      });
      const vue = (await get(eleve, `/sessions/${id}`)).body;
      expect(vue).toMatchObject({
        prix: 2000,
        paiement: 'SEQUESTRE',
        jePaie: true,
      });
      await passerLaDate(id);
      await post(prof, `/sessions/${id}/confirmation`);
      expect((await solde(prof)).disponible).toBe(0);
      await post(eleve, `/sessions/${id}/confirmation`);
      expect(await solde(eleve)).toMatchObject({
        disponible: 3000,
        sequestre: 0,
      });
      expect((await solde(prof)).disponible).toBe(2000);
      expect((await get(prof, `/sessions/${id}`)).body.paiement).toBe('LIBERE');
      const notifs = (await get(prof, '/notifications')).body.notifications;
      expect(notifs.map((n: { type: string }) => n.type)).toContain(
        'PAIEMENT_RECU',
      );
    });

    it("ne libère qu'une fois, même si la confirmation est répétée", async () => {
      const { prof, eleve, id } = await scenario(3000, 1000);
      await post(prof, `/sessions/${id}/reponse`, { accepter: true });
      await passerLaDate(id);
      await post(prof, `/sessions/${id}/confirmation`);
      await post(eleve, `/sessions/${id}/confirmation`);
      await post(eleve, `/sessions/${id}/confirmation`);
      expect((await solde(prof)).disponible).toBe(1000);
    });

    it("rend le prix à l'apprenant quand une absence est déclarée", async () => {
      const { prof, eleve, id } = await scenario(3000, 1000);
      await post(prof, `/sessions/${id}/reponse`, { accepter: true });
      await passerLaDate(id);
      await post(eleve, `/sessions/${id}/absence`);
      expect(await solde(eleve)).toMatchObject({
        disponible: 3000,
        sequestre: 0,
      });
      expect((await solde(prof)).disponible).toBe(0);
      expect((await get(eleve, `/sessions/${id}`)).body.paiement).toBe(
        'REMBOURSE',
      );
    });

    it("refuse l'acceptation si l'apprenant a retiré son argent depuis", async () => {
      const { prof, eleve, id } = await scenario(2000, 2000);
      await post(eleve, '/portefeuille/retraits', {
        montant: 2000,
        operateur: 'MTN',
        numero: '677123456',
        motDePasse: MDP,
      });
      const acc = await post(prof, `/sessions/${id}/reponse`, {
        accepter: true,
      });
      expect(acc.status).toBe(409);
      expect(
        (
          await pool.query('SELECT statut FROM session_echange WHERE id = $1', [
            id,
          ])
        ).rows[0].statut,
      ).toBe('PROPOSEE');
    });

    it("rembourse à la suppression du compte de l'enseignant et exige un solde vide", async () => {
      const { prof, eleve, id } = await scenario(3000, 1000);
      await post(prof, `/sessions/${id}/reponse`, { accepter: true });
      const sup = await prof.agent
        .post('/moi/suppression')
        .set('Origin', ORIGINE)
        .send({ motDePasse: MDP });
      expect(sup.status).toBe(204);
      expect(await solde(eleve)).toMatchObject({
        disponible: 3000,
        sequestre: 0,
      });
      const refus = await eleve.agent
        .post('/moi/suppression')
        .set('Origin', ORIGINE)
        .send({ motDePasse: MDP });
      expect(refus.status).toBe(409);
    });
  });

  describe('administration', () => {
    it('arbitre un paiement bloqué, avec mot de passe, et reste cohérent', async () => {
      const admin = await membre(true);
      const { prof, eleve, id } = await scenario(4000, 1500);
      await post(prof, `/sessions/${id}/reponse`, { accepter: true });
      await pool.query(
        `UPDATE session_echange SET date_heure = now() - interval '9 days' WHERE id = $1`,
        [id],
      );
      const vue = await get(admin, '/admin/portefeuille');
      expect(vue.status).toBe(200);
      expect(vue.body.bloques.map((b: { id: string }) => b.id)).toContain(id);
      expect(vue.body.coherent).toBe(true);
      expect((await get(eleve, '/admin/portefeuille')).status).toBe(403);
      expect(
        (
          await post(admin, `/admin/sessions/${id}/paiement`, {
            issue: 'LIBERER',
            motDePasse: 'x',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post(admin, `/admin/sessions/${id}/paiement`, {
            issue: 'LIBERER',
            motDePasse: MDP,
          })
        ).status,
      ).toBe(204);
      expect((await solde(prof)).disponible).toBe(1500);
      expect(
        (
          await post(admin, `/admin/sessions/${id}/paiement`, {
            issue: 'LIBERER',
            motDePasse: MDP,
          })
        ).status,
      ).toBe(404);
      expect((await get(admin, '/admin/portefeuille')).body.coherent).toBe(
        true,
      );
    });

    it('protège le grand livre contre toute modification', async () => {
      const m = await membre();
      await recharger(m, 1000);
      await expect(
        pool.query(
          'UPDATE ecriture_portefeuille SET delta_disponible = 9 WHERE utilisateur_id = $1',
          [m.id],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          'DELETE FROM ecriture_portefeuille WHERE utilisateur_id = $1',
          [m.id],
        ),
      ).rejects.toThrow();
    });
  });
});
