import { HttpStatus, Injectable } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';

/**
 * RG14 : suppression de compte par anonymisation, dans une seule transaction.
 * Les avis, signalements et sessions réalisées restent (intégrité et modération), sous le pseudo « Membre supprimé ».
 */
@Injectable()
export class SuppressionService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}

  async supprimer(id: string, motDePasse: string) {
    const { rows } = await this.db.query<{ hash: string; role: string }>(
      `SELECT mot_de_passe_hash AS hash, role FROM utilisateur WHERE id = $1 AND statut = 'ACTIF'`,
      [id],
    );
    const compte = rows[0];
    if (!compte)
      throw new ErreurMetier('errors.nonConnecte', HttpStatus.UNAUTHORIZED);
    // Un compte administrateur ne se supprime pas lui-même : on retirerait le seul modérateur sans le vouloir.
    if (compte.role === 'ADMIN')
      throw new ErreurMetier('errors.interdit', HttpStatus.FORBIDDEN);
    const valide = await verify(compte.hash, motDePasse).catch(() => false);
    if (!valide)
      throw new ErreurMetier('errors.identifiants', HttpStatus.UNAUTHORIZED);

    await this.db.transaction(async (c) => {
      // Sessions à venir annulées, créneaux de l'autre membre libérés.
      await c.query(
        `UPDATE creneau SET statut = 'LIBRE'
          WHERE id IN (SELECT creneau_id FROM session_echange
                        WHERE creneau_id IS NOT NULL AND statut IN ('PROPOSEE','ACCEPTEE') AND date_heure > now()
                          AND $1 IN (enseignant_id, apprenant_id))
            AND utilisateur_id <> $1`,
        [id],
      );
      await c.query(
        `UPDATE session_echange SET statut = 'ANNULEE'
          WHERE statut IN ('PROPOSEE','ACCEPTEE') AND date_heure > now() AND $1 IN (enseignant_id, apprenant_id)`,
        [id],
      );
      // Annulés plutôt que supprimés : d'anciennes sessions peuvent les référencer.
      await c.query(
        `UPDATE creneau SET statut = 'ANNULE' WHERE utilisateur_id = $1`,
        [id],
      );
      await c.query(
        `DELETE FROM declaration_competence WHERE utilisateur_id = $1`,
        [id],
      );
      await c.query(
        `DELETE FROM verification_telephone WHERE utilisateur_id = $1`,
        [id],
      );
      await c.query(`DELETE FROM notification WHERE utilisateur_id = $1`, [id]);
      await c.query(`DELETE FROM push_abonnement WHERE utilisateur_id = $1`, [id]);
      await c.query(
        `UPDATE session_connexion SET revoque_le = now() WHERE utilisateur_id = $1 AND revoque_le IS NULL`,
        [id],
      );
      // Le contenu des messages est effacé ; les fils restent pour l'autre membre.
      await c.query(
        `UPDATE message SET contenu = '[message supprimé]' WHERE expediteur_id = $1`,
        [id],
      );
      // La trace de consentement est conservée (preuve), la localisation est révoquée.
      await c.query(
        `UPDATE consentement SET revoque_le = now() WHERE utilisateur_id = $1 AND revoque_le IS NULL`,
        [id],
      );
      await c.query(
        `UPDATE utilisateur
            SET email = 'supprime-' || id::text || '@supprime.invalide', pseudo = 'Membre supprimé', bio = NULL, ville = NULL,
                mode_localisation = 'AUCUNE', latitude = NULL, longitude = NULL,
                telephone = NULL, telephone_verifie_le = NULL,
                mot_de_passe_hash = $2, statut = 'SUPPRIME'
          WHERE id = $1`,
        [id, `!${randomBytes(24).toString('hex')}`],
      );
    });
    await this.audit.enregistrer(id, 'SUPPRESSION_COMPTE', id);
  }
}
