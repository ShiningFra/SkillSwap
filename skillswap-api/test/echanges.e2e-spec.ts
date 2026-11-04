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

describe('Échanges : profils, conversations, sessions, avis, signalements', () => {
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
      await pool.query('SELECT id FROM competence ORDER BY libelle LIMIT 3')
    ).rows.map((r) => r.id);
  });
  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  type Membre = { agent: request.Agent; id: string };
  const post = (m: Membre, url: string, corps: object = {}) =>
    m.agent.post(url).set('Origin', ORIGINE).send(corps);
  const get = (m: Membre, url: string) => m.agent.get(url);

  /** Crée un membre ; `verifie` lui donne un téléphone vérifié (RG17). */
  async function membre(verifie = true): Promise<Membre> {
    const agent = request.agent(app.getHttpServer());
    const n = ++compteur;
    const res = await agent
      .post('/auth/inscription')
      .set('Origin', ORIGINE)
      .send({
        email: `ech${Date.now()}${n}@exemple.cm`,
        pseudo: `Membre${n}`,
        motDePasse: MDP,
        majeur: true,
        cgu: true,
      });
    expect(res.status).toBe(201);
    if (verifie) {
      await pool.query(
        `UPDATE utilisateur SET telephone = $2, telephone_verifie_le = now() WHERE id = $1`,
        [res.body.id, `+2376${String(Date.now()).slice(-6)}${n % 10}${n % 7}`],
      );
    }
    return { agent, id: res.body.id };
  }

  async function offrir(m: Membre, competenceId: string) {
    await pool.query(
      `INSERT INTO declaration_competence (utilisateur_id, competence_id, sens, niveau, format) VALUES ($1, $2, 'OFFERTE', 'AVANCE', 'LES_DEUX') ON CONFLICT DO NOTHING`,
      [m.id, competenceId],
    );
  }

  let decalage = 10;
  async function creneau(m: Membre) {
    decalage += 3;
    const debut = new Date(Date.now() + decalage * 86_400_000);
    const res = await post(m, '/moi/creneaux', {
      debut: debut.toISOString(),
      fin: new Date(+debut + 3_600_000).toISOString(),
      format: 'LES_DEUX',
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** Deux membres, une conversation, une session proposée par l'apprenant. */
  async function scenario() {
    const prof = await membre();
    const eleve = await membre();
    await offrir(prof, competences[0]);
    const c = (await post(eleve, '/conversations', { membreId: prof.id })).body
      .id as string;
    const k = await creneau(prof);
    const s = await post(eleve, `/conversations/${c}/sessions`, {
      creneauId: k,
      format: 'DISTANCE',
      contrepartie: 'TROC',
    });
    expect(s.status).toBe(201);
    return {
      prof,
      eleve,
      conv: c,
      creneauId: k,
      sessionId: s.body.id as string,
    };
  }
  const passerLaDate = (id: string) =>
    pool.query(
      `UPDATE session_echange SET date_heure = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );

  describe('conversations', () => {
    it('est unique par couple de membres (RG2) et réutilisée', async () => {
      const a = await membre();
      const b = await membre();
      const c1 = await post(a, '/conversations', { membreId: b.id });
      const c2 = await post(b, '/conversations', { membreId: a.id });
      expect(c1.status).toBe(201);
      expect(c2.body.id).toBe(c1.body.id);
    });

    it('refuse un téléphone non vérifié (RG17)', async () => {
      const a = await membre(false);
      const b = await membre();
      const r = await post(a, '/conversations', { membreId: b.id });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    });

    it("est invisible d'un tiers (ES6)", async () => {
      const a = await membre();
      const b = await membre();
      const tiers = await membre();
      const c = (await post(a, '/conversations', { membreId: b.id })).body.id;
      expect((await get(tiers, `/conversations/${c}`)).status).toBe(404);
      expect(
        (await post(tiers, `/conversations/${c}/messages`, { texte: 'coucou' }))
          .status,
      ).toBe(404);
      expect((await get(tiers, '/conversations')).body).toEqual([]);
    });

    it('échange des messages, marque la lecture et notifie', async () => {
      const a = await membre();
      const b = await membre();
      const c = (await post(a, '/conversations', { membreId: b.id })).body.id;
      expect(
        (await post(a, `/conversations/${c}/messages`, { texte: 'Salut' }))
          .status,
      ).toBe(201);
      expect(
        (await post(a, `/conversations/${c}/messages`, { texte: '   ' }))
          .status,
      ).toBe(400);
      const vue = await get(b, `/conversations/${c}`);
      expect(vue.body.messages).toEqual([
        expect.objectContaining({ texte: 'Salut', deMoi: false }),
      ]);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM notification WHERE utilisateur_id = $1 AND type = 'NOUVEAU_MESSAGE'`,
        [b.id],
      );
      expect(rows[0].n).toBe(1);
      expect(
        (
          await pool.query(
            'SELECT lu_le FROM message WHERE conversation_id = $1',
            [c],
          )
        ).rows[0].lu_le,
      ).not.toBeNull();
    });
  });

  describe('recherche et profils (ES8)', () => {
    it('ne renvoie jamais de coordonnées, seulement un palier', async () => {
      const a = await membre();
      const b = await membre();
      await offrir(b, competences[1]);
      await pool.query(
        `UPDATE utilisateur SET latitude = 3.8480, longitude = 11.5021, mode_localisation = 'AUTOMATIQUE' WHERE id IN ($1, $2)`,
        [a.id, b.id],
      );
      const res = await get(a, `/profils?competenceId=${competences[1]}`);
      expect(res.status).toBe(200);
      const texte = JSON.stringify(res.body);
      expect(texte).not.toMatch(/latitude|longitude|3\.848|11\.502/);
      const profil = await get(a, `/profils/${b.id}`);
      expect(profil.status).toBe(200);
      expect(JSON.stringify(profil.body)).not.toMatch(
        /latitude|longitude|"telephone"|"email"|3\.848|11\.502/i,
      );
    });

    it('exige une session ouverte', async () => {
      expect((await request(app.getHttpServer()).get('/profils')).status).toBe(
        401,
      );
    });
  });

  describe('sessions', () => {
    it("réserve le créneau de façon atomique (RG9) et le libère à l'expiration (72 h)", async () => {
      const { prof, eleve, conv, creneauId, sessionId } = await scenario();
      const autre = await membre();
      const c2 = (await post(autre, '/conversations', { membreId: prof.id }))
        .body.id;
      const doublon = await post(autre, `/conversations/${c2}/sessions`, {
        creneauId,
        format: 'DISTANCE',
        contrepartie: 'GRATUIT',
      });
      expect(doublon.status).toBe(409);
      await pool.query(
        `UPDATE session_echange SET cree_le = now() - interval '73 hours' WHERE id = $1`,
        [sessionId],
      );
      expect((await get(eleve, `/sessions/${sessionId}`)).body.statut).toBe(
        'EXPIREE',
      );
      const k = await pool.query('SELECT statut FROM creneau WHERE id = $1', [
        creneauId,
      ]);
      expect(k.rows[0].statut).toBe('LIBRE');
      void conv;
    });

    it("n'est visible que de ses deux participants", async () => {
      const { sessionId } = await scenario();
      const tiers = await membre();
      expect((await get(tiers, `/sessions/${sessionId}`)).status).toBe(404);
      expect(
        (
          await post(tiers, `/sessions/${sessionId}/reponse`, {
            accepter: true,
          })
        ).status,
      ).toBe(404);
    });

    it('impose lieu en présentiel et contrepartie (RG16, RG20)', async () => {
      const prof = await membre();
      const eleve = await membre();
      await offrir(prof, competences[0]);
      const c = (await post(eleve, '/conversations', { membreId: prof.id }))
        .body.id;
      const k = await creneau(prof);
      expect(
        (
          await post(eleve, `/conversations/${c}/sessions`, {
            creneauId: k,
            format: 'PRESENTIEL',
            contrepartie: 'TROC',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(eleve, `/conversations/${c}/sessions`, {
            creneauId: k,
            format: 'DISTANCE',
            lieuType: 'PUBLIC',
            contrepartie: 'TROC',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(eleve, `/conversations/${c}/sessions`, {
            creneauId: k,
            format: 'DISTANCE',
          })
        ).status,
      ).toBe(400);
    });

    it('seul le destinataire répond ; un refus libère le créneau', async () => {
      const { prof, eleve, creneauId, sessionId } = await scenario();
      expect(
        (
          await post(eleve, `/sessions/${sessionId}/reponse`, {
            accepter: true,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(prof, `/sessions/${sessionId}/reponse`, {
            accepter: false,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await pool.query('SELECT statut FROM creneau WHERE id = $1', [
            creneauId,
          ])
        ).rows[0].statut,
      ).toBe('LIBRE');
      expect(
        (await post(prof, `/sessions/${sessionId}/reponse`, { accepter: true }))
          .status,
      ).toBe(409);
    });

    it('parcours complet : accepter, confirmer des deux côtés, avis unique', async () => {
      const { prof, eleve, sessionId } = await scenario();
      expect(
        (await post(prof, `/sessions/${sessionId}/reponse`, { accepter: true }))
          .status,
      ).toBe(204);
      expect(
        (await post(prof, `/sessions/${sessionId}/confirmation`)).status,
      ).toBe(409); // pas encore commencée
      await passerLaDate(sessionId);
      expect(
        (await post(prof, `/sessions/${sessionId}/confirmation`)).status,
      ).toBe(204);
      expect((await get(prof, `/sessions/${sessionId}`)).body).toEqual(
        expect.objectContaining({
          statut: 'ACCEPTEE',
          mesConfirmation: true,
          saConfirmation: false,
        }),
      );
      expect(
        (await post(prof, `/sessions/${sessionId}/avis`, { note: 5 })).status,
      ).toBeGreaterThanOrEqual(400); // pas encore réalisée
      expect(
        (await post(eleve, `/sessions/${sessionId}/confirmation`)).status,
      ).toBe(204);
      expect((await get(eleve, `/sessions/${sessionId}`)).body.statut).toBe(
        'REALISEE',
      );
      expect(
        (
          await post(eleve, `/sessions/${sessionId}/avis`, {
            note: 5,
            commentaire: 'Très clair',
          })
        ).status,
      ).toBe(201);
      expect(
        (await post(eleve, `/sessions/${sessionId}/avis`, { note: 4 })).status,
      ).toBe(409);
      expect(
        (await post(prof, `/sessions/${sessionId}/avis`, { note: 9 })).status,
      ).toBe(400);
      expect((await get(eleve, `/sessions/${sessionId}`)).body.avisDonne).toBe(
        true,
      );
    });

    it('avertit à la première absence puis suspend au seuil (RG19)', async () => {
      const absent = await membre();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const prof = await membre();
        await offrir(prof, competences[0]);
        const c = (await post(absent, '/conversations', { membreId: prof.id }))
          .body.id;
        const k = await creneau(prof);
        const s = await post(absent, `/conversations/${c}/sessions`, {
          creneauId: k,
          format: 'DISTANCE',
          contrepartie: 'GRATUIT',
        });
        await post(prof, `/sessions/${s.body.id}/reponse`, { accepter: true });
        await passerLaDate(s.body.id);
        ids.push(s.body.id);
        const declarant = prof;
        expect(
          (await post(declarant, `/sessions/${s.body.id}/absence`)).status,
        ).toBe(204);
        const notif = await pool.query(
          `SELECT type FROM notification WHERE utilisateur_id = $1 ORDER BY cree_le DESC LIMIT 1`,
          [absent.id],
        );
        expect(notif.rows[0].type).toBe(
          i < 2 ? 'AVERTISSEMENT_ABSENCE' : 'SUSPENSION',
        );
      }
      expect(
        (
          await pool.query('SELECT statut FROM utilisateur WHERE id = $1', [
            absent.id,
          ])
        ).rows[0].statut,
      ).toBe('SUSPENDU');
      expect((await get(absent, '/moi')).status).toBe(401); // sessions révoquées
    });

    it('refuse une absence déclarée par qui a déjà confirmé', async () => {
      const { prof, sessionId } = await scenario();
      await post(prof, `/sessions/${sessionId}/reponse`, { accepter: true });
      await passerLaDate(sessionId);
      await post(prof, `/sessions/${sessionId}/confirmation`);
      expect((await post(prof, `/sessions/${sessionId}/absence`)).status).toBe(
        409,
      );
    });
  });

  describe('signalements', () => {
    it("enregistre un signalement, refuse l'auto-signalement et le doublon ouvert (RG13)", async () => {
      const a = await membre();
      const b = await membre();
      expect(
        (await post(a, '/signalements', { membreId: a.id, motif: 'SPAM' }))
          .status,
      ).toBe(400);
      expect(
        (
          await post(a, '/signalements', {
            membreId: b.id,
            motif: 'SPAM',
            description: 'pub',
          })
        ).status,
      ).toBe(201);
      expect(
        (await post(a, '/signalements', { membreId: b.id, motif: 'SPAM' }))
          .status,
      ).toBe(409);
      expect(
        (await post(a, '/signalements', { membreId: b.id, motif: 'INCONNU' }))
          .status,
      ).toBe(400);
    });

    it('plafonne à 5 signalements par heure', async () => {
      const a = await membre();
      for (let i = 0; i < 5; i++) {
        const cible = await membre();
        expect(
          (
            await post(a, '/signalements', {
              membreId: cible.id,
              motif: 'AUTRE',
            })
          ).status,
        ).toBe(201);
      }
      const cible = await membre();
      expect(
        (await post(a, '/signalements', { membreId: cible.id, motif: 'AUTRE' }))
          .status,
      ).toBe(429);
    });
  });
});
