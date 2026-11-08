import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import {
  CLES_PARAMETRES,
  ParametresService,
} from '../parametres/parametres.service';
import type { ClePametre } from '../parametres/parametres.service';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';

const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export type DecisionModeration = 'AVERTIR' | 'SUSPENDRE' | 'REJETER';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly parametres: ParametresService,
  ) {}

  /** Indicateurs des 30 derniers jours (CDC : taux de concrétisation, activité, compétences confirmées). */
  async indicateurs() {
    const { rows } = await this.db.query<{
      realisees: number;
      conversations: number;
      offertes: number;
      confirmees: number;
      ouverts: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM session_echange WHERE statut = 'REALISEE' AND realisee_le > now() - interval '30 days') AS realisees,
         (SELECT count(*)::int FROM conversation WHERE cree_le > now() - interval '30 days') AS conversations,
         (SELECT count(*)::int FROM declaration_competence WHERE sens = 'OFFERTE') AS offertes,
         (SELECT count(*)::int FROM v_competence_confirmee WHERE confirmee) AS confirmees,
         (SELECT count(*)::int FROM signalement WHERE statut IN ('OUVERT','EN_COURS')) AS ouverts`,
    );
    const r = rows[0];
    return {
      sessionsRealisees30j: r.realisees,
      conversations30j: r.conversations,
      tauxConcretisation:
        r.conversations === 0
          ? null
          : Math.round((r.realisees / r.conversations) * 100),
      competencesOffertes: r.offertes,
      competencesConfirmees: r.confirmees,
      signalementsOuverts: r.ouverts,
    };
  }

  /** File de modération (RG22) : gravité d'abord, puis nombre de signaleurs distincts, puis ancienneté. */
  async lister() {
    const { rows } = await this.db.query(
      `SELECT s.id, s.motif, s.gravite, s.statut, s.cree_le AS "creeLe",
              c.pseudo AS "ciblePseudo",
              (SELECT count(DISTINCT x.auteur_id)::int FROM signalement x WHERE x.cible_id = s.cible_id) AS "nbSignaleurs"
         FROM signalement s JOIN utilisateur c ON c.id = s.cible_id
        WHERE s.statut IN ('OUVERT','EN_COURS')
        ORDER BY CASE s.gravite WHEN 'HAUTE' THEN 0 WHEN 'MOYENNE' THEN 1 ELSE 2 END,
                 "nbSignaleurs" DESC, s.cree_le
        LIMIT 100`,
    );
    return rows;
  }

  async detail(id: string) {
    const { rows } = await this.db.query<{
      id: string;
      motif: string;
      statut: string;
      description: string | null;
      creeLe: Date;
      cibleId: string;
      ciblePseudo: string;
      cibleStatut: string;
      auteurPseudo: string;
    }>(
      `SELECT s.id, s.motif, s.statut, s.description, s.cree_le AS "creeLe",
              c.id AS "cibleId", c.pseudo AS "ciblePseudo", c.statut AS "cibleStatut",
              a.pseudo AS "auteurPseudo"
         FROM signalement s
         JOIN utilisateur c ON c.id = s.cible_id
         JOIN utilisateur a ON a.id = s.auteur_id
        WHERE s.id = $1`,
      [id],
    );
    if (rows.length === 0)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    const s = rows[0];
    const h = await this.db.query<{
      realisees: number;
      absences: number;
      recus: number;
      signaleurs: number;
      note: string | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM session_echange WHERE statut = 'REALISEE' AND $1 IN (enseignant_id, apprenant_id)) AS realisees,
         (SELECT count(*)::int FROM session_echange WHERE absent_id = $1) AS absences,
         (SELECT count(*)::int FROM signalement WHERE cible_id = $1) AS recus,
         (SELECT count(DISTINCT auteur_id)::int FROM signalement WHERE cible_id = $1) AS signaleurs,
         (SELECT round(avg(note)::numeric, 1)::text FROM avis WHERE cible_id = $1) AS note`,
      [s.cibleId],
    );
    const { cibleId: _omis, ...visible } = s;
    void _omis;
    return {
      ...visible,
      historique: {
        sessionsRealisees: h.rows[0].realisees,
        absences: h.rows[0].absences,
        signalementsRecus: h.rows[0].recus,
        signaleursDistincts: h.rows[0].signaleurs,
        noteMoyenne: h.rows[0].note === null ? null : Number(h.rows[0].note),
      },
    };
  }

  /** Une décision clôt le signalement et la trace dans le journal d'audit (ES10). */
  async decider(
    adminId: string,
    id: string,
    decision: DecisionModeration,
    commentaire?: string,
  ) {
    const cible = await this.db.query<{ cibleId: string; statut: string }>(
      `SELECT cible_id AS "cibleId", statut FROM signalement WHERE id = $1`,
      [id],
    );
    if (cible.rows.length === 0)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    const { cibleId } = cible.rows[0];
    const statut = decision === 'REJETER' ? 'REJETE' : 'TRAITE';
    const texte = commentaire || decision;
    // Condition sur le statut : deux administrateurs ne peuvent pas traiter le même signalement.
    const maj = await this.db.query(
      `UPDATE signalement SET statut = $2, decision = $3, moderateur_id = $4, traite_le = now()
        WHERE id = $1 AND statut IN ('OUVERT','EN_COURS')`,
      [id, statut, texte, adminId],
    );
    if (maj.rowCount === 0)
      throw new ErreurMetier('errors.dejaTraite', HttpStatus.CONFLICT);
    if (decision === 'AVERTIR') {
      await this.db.query(
        `INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, 'AVERTISSEMENT', $2)`,
        [
          cibleId,
          'Un signalement a été retenu contre ton compte. Merci de respecter les règles de la communauté.',
        ],
      );
    }
    if (decision === 'SUSPENDRE') {
      await this.db.query(
        `UPDATE utilisateur SET statut = 'SUSPENDU' WHERE id = $1`,
        [cibleId],
      );
      await this.db.query(
        `UPDATE session_connexion SET revoque_le = now() WHERE utilisateur_id = $1 AND revoque_le IS NULL`,
        [cibleId],
      );
      await this.db.query(
        `INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, 'SUSPENSION', 'Ton compte a été suspendu après un signalement.')`,
        [cibleId],
      );
    }
    await this.audit.enregistrer(adminId, 'MODERATION', id, { decision });
  }

  /** Mot de passe provisoire : 16 caractères tirés d'un CSPRNG, sans caractères ambigus. */
  private genererMdp() {
    return Array.from(
      { length: 16 },
      () => ALPHABET[randomInt(ALPHABET.length)],
    ).join('');
  }

  /** Les actions sensibles redemandent le mot de passe de l'administrateur qui agit. */
  private async confirmer(acteurId: string, mdp: string) {
    const { rows } = await this.db.query<{ h: string }>(
      'SELECT mot_de_passe_hash AS h FROM utilisateur WHERE id = $1',
      [acteurId],
    );
    const ok = rows[0]
      ? await verify(rows[0].h, mdp).catch(() => false)
      : false;
    if (!ok)
      throw new ErreurMetier('errors.identifiants', HttpStatus.UNAUTHORIZED);
  }

  async listerParametres() {
    return this.parametres.tous();
  }

  /** Active ou désactive une fonctionnalité ; demande le mot de passe et inscrit l'action au journal d'audit. */
  async modifierParametre(
    acteurId: string,
    mdp: string,
    cle: string,
    actif: boolean,
    message: string | null,
  ) {
    if (!(CLES_PARAMETRES as readonly string[]).includes(cle))
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    await this.confirmer(acteurId, mdp);
    await this.parametres.modifier(acteurId, cle as ClePametre, actif, message);
    await this.audit.enregistrer(acteurId, 'PARAMETRE_MODIFIE', undefined, {
      cle,
      actif,
    });
  }

  async administrateurs() {
    const { rows } = await this.db.query(
      `SELECT id, pseudo, email, mdp_provisoire AS "mdpProvisoire", cree_le AS "creeLe"
         FROM utilisateur WHERE role = 'ADMIN' AND statut = 'ACTIF' ORDER BY cree_le`,
    );
    return rows;
  }

  /** Promeut un membre existant (RG : compte actif uniquement). */
  async nommer(acteurId: string, mdp: string, email: string) {
    await this.confirmer(acteurId, mdp);
    const { rows } = await this.db.query<{
      id: string;
      role: string;
      statut: string;
    }>(
      'SELECT id, role, statut FROM utilisateur WHERE lower(email) = lower($1)',
      [email.trim()],
    );
    const cible = rows[0];
    if (!cible)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    if (cible.statut !== 'ACTIF')
      throw new ErreurMetier('errors.compteInactif', HttpStatus.CONFLICT);
    if (cible.role === 'ADMIN')
      throw new ErreurMetier('errors.dejaAdmin', HttpStatus.CONFLICT);
    await this.db.query("UPDATE utilisateur SET role = 'ADMIN' WHERE id = $1", [
      cible.id,
    ]);
    await this.audit.enregistrer(acteurId, 'ADMIN_NOMME', cible.id);
  }

  /** Crée un compte administrateur ; le mot de passe provisoire n'est renvoyé qu'une fois. */
  async creer(acteurId: string, mdp: string, email: string, pseudo: string) {
    await this.confirmer(acteurId, mdp);
    const provisoire = this.genererMdp();
    const h = await hash(provisoire, PARAMS);
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO utilisateur (email, mot_de_passe_hash, pseudo, role, mdp_provisoire, majeur_confirme_le)
         VALUES ($1, $2, $3, 'ADMIN', true, now()) RETURNING id`,
        [email.trim(), h, pseudo],
      );
      await this.audit.enregistrer(acteurId, 'ADMIN_CREE', rows[0].id);
      return { id: rows[0].id, motDePasseProvisoire: provisoire };
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ErreurMetier('errors.emailPris', HttpStatus.CONFLICT);
      throw e;
    }
  }

  /** Rétrograde un administrateur en membre. Jamais soi-même, jamais le dernier. */
  async retirer(acteurId: string, mdp: string, cibleId: string) {
    await this.confirmer(acteurId, mdp);
    if (cibleId === acteurId)
      throw new ErreurMetier('errors.retraitSoi', HttpStatus.CONFLICT);
    await this.db.transaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM utilisateur WHERE role = 'ADMIN' AND statut = 'ACTIF' FOR UPDATE",
      );
      if (!rows.some((r) => r.id === cibleId))
        throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
      if (rows.length <= 1)
        throw new ErreurMetier('errors.dernierAdmin', HttpStatus.CONFLICT);
      await c.query("UPDATE utilisateur SET role = 'MEMBRE' WHERE id = $1", [
        cibleId,
      ]);
    });
    await this.audit.enregistrer(acteurId, 'ADMIN_RETIRE', cibleId);
  }
}
