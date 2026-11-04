import { HttpStatus, Injectable } from '@nestjs/common';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';

export type DecisionModeration = 'AVERTIR' | 'SUSPENDRE' | 'REJETER';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
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

  /** File de modération : les signalements ouverts d'abord, les plus anciens en tête. */
  async lister() {
    const { rows } = await this.db.query(
      `SELECT s.id, s.motif, s.statut, s.cree_le AS "creeLe",
              c.pseudo AS "ciblePseudo",
              (SELECT count(DISTINCT x.auteur_id)::int FROM signalement x WHERE x.cible_id = s.cible_id) AS "nbSignaleurs"
         FROM signalement s JOIN utilisateur c ON c.id = s.cible_id
        WHERE s.statut IN ('OUVERT','EN_COURS')
        ORDER BY s.cree_le
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
}
