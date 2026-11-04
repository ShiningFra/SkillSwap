import { HttpStatus, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { Audit } from '../common/audit.service';
import { ErreurMetier, traduirePg } from '../common/erreurs';
import { Db } from '../db/db.service';
import { ABSENCES, EXPIRATION_PROPOSITION_HEURES } from '../shared/domain';
import { avisSchema, propositionSchema } from '../shared/schemas';
import { libelleDate } from '../profils/profils.service';
import { ConversationsService } from './conversations.service';

interface LigneSession {
  id: string;
  competence_id: string;
  date_heure: Date;
  format: string;
  lieu_type: string | null;
  contrepartie: string;
  statut: string;
  propose_par_id: string;
  enseignant_id: string;
  apprenant_id: string;
  confirme_enseignant_le: Date | null;
  confirme_apprenant_le: Date | null;
  absent_id: string | null;
  autre_id: string;
  autre_pseudo: string;
  avis_donne: boolean;
}

const SELECT_SESSION = `
  SELECT s.id, s.competence_id, s.date_heure, s.format, s.lieu_type, s.contrepartie, s.statut, s.propose_par_id,
         s.enseignant_id, s.apprenant_id, s.confirme_enseignant_le, s.confirme_apprenant_le, s.absent_id,
         o.id AS autre_id, o.pseudo AS autre_pseudo,
         EXISTS (SELECT 1 FROM avis a WHERE a.session_id = s.id AND a.auteur_id = $1) AS avis_donne
    FROM session_echange s
    JOIN utilisateur o ON o.id = CASE WHEN s.enseignant_id = $1 THEN s.apprenant_id ELSE s.enseignant_id END
   WHERE $1 IN (s.enseignant_id, s.apprenant_id)`;

@Injectable()
export class SessionsService {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationsService,
    private readonly audit: Audit,
  ) {}

  private vue(moiId: string, s: LigneSession) {
    const moiEnseignant = s.enseignant_id === moiId;
    const miennes = moiEnseignant
      ? s.confirme_enseignant_le
      : s.confirme_apprenant_le;
    const siennes = moiEnseignant
      ? s.confirme_apprenant_le
      : s.confirme_enseignant_le;
    return {
      id: s.id,
      membre: { id: s.autre_id, pseudo: s.autre_pseudo },
      competenceId: s.competence_id,
      dateHeure: s.date_heure,
      creneauLibelle: libelleDate(s.date_heure),
      format: s.format,
      lieuType: s.lieu_type ?? undefined,
      contrepartie: s.contrepartie,
      statut: s.statut,
      proposeParMoi: s.propose_par_id === moiId,
      mesConfirmation: miennes !== null,
      saConfirmation: siennes !== null,
      absent:
        s.absent_id === null
          ? undefined
          : s.absent_id === moiId
            ? 'moi'
            : 'autre',
      avisDonne: s.avis_donne,
    };
  }

  /** RG10 : une proposition sans réponse après 72 h expire et libère son créneau (appelé à chaque lecture). */
  private async expirer() {
    await this.db.query(
      `WITH e AS (UPDATE session_echange SET statut = 'EXPIREE' WHERE statut = 'PROPOSEE' AND cree_le < now() - make_interval(hours => $1) RETURNING creneau_id)
       UPDATE creneau SET statut = 'LIBRE' WHERE id IN (SELECT creneau_id FROM e) AND statut = 'RESERVE'`,
      [EXPIRATION_PROPOSITION_HEURES],
    );
  }

  async lister(moiId: string) {
    await this.expirer();
    const { rows } = await this.db.query<LigneSession>(
      `${SELECT_SESSION} ORDER BY s.date_heure DESC`,
      [moiId],
    );
    return rows.map((r) => this.vue(moiId, r));
  }

  async obtenir(moiId: string, id: string) {
    await this.expirer();
    const { rows } = await this.db.query<LigneSession>(
      `${SELECT_SESSION} AND s.id = $2`,
      [moiId, id],
    );
    if (!rows[0])
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    return this.vue(moiId, rows[0]);
  }

  /**
   * Proposition de session à partir d'un créneau de l'autre membre, qui devient l'enseignant.
   * RG9 : le créneau est réservé de façon atomique. RG8, RG17, RG20 : déclencheurs et contraintes de la base.
   */
  async proposer(
    moiId: string,
    conversationId: string,
    v: z.infer<typeof propositionSchema>,
  ) {
    const autre = await this.conversations.interlocuteurDe(
      moiId,
      conversationId,
    );
    if (autre.statut === 'SUPPRIME')
      throw new ErreurMetier('errors.membreSupprime', HttpStatus.GONE);
    try {
      return await this.db.transaction(async (c) => {
        const k = await c.query<{ debut: Date; fin: Date; format: string }>(
          `UPDATE creneau SET statut = 'RESERVE' WHERE id = $1 AND utilisateur_id = $2 AND statut = 'LIBRE' AND debut > now() RETURNING debut, fin, format`,
          [v.creneauId, autre.id],
        );
        if (!k.rows[0])
          throw new ErreurMetier('errors.creneauPris', HttpStatus.CONFLICT);
        const creneau = k.rows[0];
        if (creneau.format !== 'LES_DEUX' && creneau.format !== v.format)
          throw new ErreurMetier('errors.creneau', HttpStatus.BAD_REQUEST);

        let competenceId = v.competenceId;
        if (!competenceId) {
          const offres = await c.query<{ competence_id: string }>(
            `SELECT competence_id FROM declaration_competence WHERE utilisateur_id = $1 AND sens = 'OFFERTE'`,
            [autre.id],
          );
          if (offres.rowCount !== 1)
            throw new ErreurMetier('errors.competence', HttpStatus.BAD_REQUEST);
          competenceId = offres.rows[0].competence_id;
        }
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO session_echange (conversation_id, enseignant_id, apprenant_id, propose_par_id, competence_id, creneau_id, date_heure, duree_min, format, lieu_type, contrepartie)
           VALUES ($1, $2, $3, $3, $4, $5, $6, GREATEST(1, (extract(epoch FROM ($7::timestamptz - $6::timestamptz)) / 60)::int), $8, $9, $10) RETURNING id`,
          [
            conversationId,
            autre.id,
            moiId,
            competenceId,
            v.creneauId,
            creneau.debut,
            creneau.fin,
            v.format,
            v.lieuType ?? null,
            v.contrepartie,
          ],
        );
        await c.query(
          `INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, 'SESSION_PROPOSEE', 'Tu as reçu une proposition de session')`,
          [autre.id],
        );
        return { id: rows[0].id };
      });
    } catch (e) {
      if (e instanceof ErreurMetier) throw e;
      if ((e as { code?: string }).code === '23505')
        throw new ErreurMetier('errors.creneauPris', HttpStatus.CONFLICT);
      return traduirePg(e);
    }
  }

  /** Charge la session verrouillée, réservée à ses deux participants (ES6). */
  private async verrouiller(c: PoolClient, moiId: string, id: string) {
    const { rows } = await c.query<
      LigneSession & { creneau_id: string | null }
    >(
      `SELECT s.*, o.id AS autre_id, o.pseudo AS autre_pseudo, false AS avis_donne FROM session_echange s
         JOIN utilisateur o ON o.id = CASE WHEN s.enseignant_id = $1 THEN s.apprenant_id ELSE s.enseignant_id END
        WHERE s.id = $2 AND $1 IN (s.enseignant_id, s.apprenant_id) FOR UPDATE OF s`,
      [moiId, id],
    );
    if (!rows[0])
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    return rows[0];
  }

  /** RG10 : seul le destinataire de la proposition y répond ; un refus libère le créneau. */
  async repondre(moiId: string, id: string, accepter: boolean) {
    await this.expirer();
    await this.db.transaction(async (c) => {
      const s = await this.verrouiller(c, moiId, id);
      if (s.propose_par_id === moiId)
        throw new ErreurMetier('errors.interdit', HttpStatus.FORBIDDEN);
      if (s.statut !== 'PROPOSEE')
        throw new ErreurMetier(
          'errors.sessionDejaTraitee',
          HttpStatus.CONFLICT,
        );
      await c.query('UPDATE session_echange SET statut = $2 WHERE id = $1', [
        id,
        accepter ? 'ACCEPTEE' : 'REFUSEE',
      ]);
      if (!accepter && s.creneau_id)
        await c.query(
          `UPDATE creneau SET statut = 'LIBRE' WHERE id = $1 AND statut = 'RESERVE'`,
          [s.creneau_id],
        );
      await c.query(
        `INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, $2, $3)`,
        [
          s.propose_par_id,
          accepter ? 'SESSION_ACCEPTEE' : 'SESSION_REFUSEE',
          accepter
            ? 'Ta proposition de session est acceptée'
            : 'Ta proposition de session est refusée',
        ],
      );
    });
  }

  /** RG11 : la session devient réalisée quand les deux participants ont confirmé, une fois l'heure passée. */
  async confirmer(moiId: string, id: string) {
    await this.db.transaction(async (c) => {
      const s = await this.verrouiller(c, moiId, id);
      if (s.statut !== 'ACCEPTEE')
        throw new ErreurMetier(
          'errors.sessionDejaTraitee',
          HttpStatus.CONFLICT,
        );
      if (s.date_heure > new Date())
        throw new ErreurMetier(
          'errors.sessionPasCommencee',
          HttpStatus.CONFLICT,
        );
      const colonne =
        s.enseignant_id === moiId
          ? 'confirme_enseignant_le'
          : 'confirme_apprenant_le';
      await c.query(
        `UPDATE session_echange SET ${colonne} = COALESCE(${colonne}, now()) WHERE id = $1`,
        [id],
      );
      await c.query(
        `UPDATE session_echange SET statut = 'REALISEE', realisee_le = now()
          WHERE id = $1 AND confirme_enseignant_le IS NOT NULL AND confirme_apprenant_le IS NOT NULL`,
        [id],
      );
    });
  }

  /**
   * RG19 : l'autre membre ne s'est pas présenté. Avertissement dès la 1re absence sur 90 jours, suspension au seuil.
   * Une absence ne peut plus être déclarée par un membre qui a déjà confirmé la session.
   */
  async declarerAbsence(moiId: string, id: string) {
    const issue = await this.db.transaction(async (c) => {
      const s = await this.verrouiller(c, moiId, id);
      if (s.statut !== 'ACCEPTEE')
        throw new ErreurMetier(
          'errors.sessionDejaTraitee',
          HttpStatus.CONFLICT,
        );
      if (s.date_heure > new Date())
        throw new ErreurMetier(
          'errors.sessionPasCommencee',
          HttpStatus.CONFLICT,
        );
      const aConfirme =
        s.enseignant_id === moiId
          ? s.confirme_enseignant_le
          : s.confirme_apprenant_le;
      if (aConfirme)
        throw new ErreurMetier(
          'errors.sessionDejaTraitee',
          HttpStatus.CONFLICT,
        );
      await c.query(
        `UPDATE session_echange SET statut = 'NON_REALISEE', absent_id = $2 WHERE id = $1`,
        [id, s.autre_id],
      );
      const { rows } = await c.query<{ nb: number }>(
        'SELECT nb_absences_90j::int AS nb FROM v_absences WHERE utilisateur_id = $1',
        [s.autre_id],
      );
      const nb = rows[0]?.nb ?? 0;
      if (nb >= ABSENCES.suspensionDes) {
        await c.query(
          `UPDATE utilisateur SET statut = 'SUSPENDU' WHERE id = $1`,
          [s.autre_id],
        );
        await c.query(
          'UPDATE session_connexion SET revoque_le = now() WHERE utilisateur_id = $1 AND revoque_le IS NULL',
          [s.autre_id],
        );
        await c.query(
          `INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, 'SUSPENSION', 'Ton compte est suspendu après des absences répétées')`,
          [s.autre_id],
        );
      } else if (nb >= ABSENCES.avertissementDes) {
        await c.query(
          `INSERT INTO notification (utilisateur_id, type, contenu) VALUES ($1, 'AVERTISSEMENT_ABSENCE', 'Une absence a été déclarée sur une de tes sessions')`,
          [s.autre_id],
        );
      }
      return { absentId: s.autre_id, nb };
    });
    await this.audit.enregistrer(moiId, 'ABSENCE_DECLAREE', id, {
      absences90j: issue.nb,
    });
  }

  /** RG11 : un seul avis par auteur et par session, sur une session réalisée. */
  async publierAvis(moiId: string, id: string, v: z.infer<typeof avisSchema>) {
    try {
      await this.db.transaction(async (c) => {
        const s = await this.verrouiller(c, moiId, id);
        await c.query(
          'INSERT INTO avis (session_id, auteur_id, cible_id, note, commentaire) VALUES ($1, $2, $3, $4, $5)',
          [id, moiId, s.autre_id, v.note, v.commentaire || null],
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ErreurMetier('errors.dejaAvis', HttpStatus.CONFLICT);
      if (e instanceof ErreurMetier) throw e;
      return traduirePg(e);
    }
  }
}
