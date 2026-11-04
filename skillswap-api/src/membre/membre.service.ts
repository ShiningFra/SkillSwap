import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';
import { declarationSchema, localisationSchema } from '../shared/schemas';

@Injectable()
export class MembreService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}

  /**
   * RG5 : les coordonnées n'existent qu'en mode AUTOMATIQUE, avec un consentement actif ; changer de mode
   * efface les coordonnées et révoque le consentement. Elles ne sont jamais renvoyées (ES8).
   */
  async definirLocalisation(id: string, v: z.infer<typeof localisationSchema>) {
    await this.db.transaction(async (c) => {
      if (v.mode === 'AUTOMATIQUE') {
        await c.query(
          `UPDATE utilisateur SET mode_localisation = 'AUTOMATIQUE', latitude = $2, longitude = $3 WHERE id = $1`,
          [id, v.latitude, v.longitude],
        );
        await c.query(
          `INSERT INTO consentement (utilisateur_id, finalite, version_texte) VALUES ($1, 'LOCALISATION', 'loc-2026-11')
           ON CONFLICT (utilisateur_id, finalite) WHERE revoque_le IS NULL DO NOTHING`,
          [id],
        );
      } else {
        await c.query(
          'UPDATE utilisateur SET mode_localisation = $2, ville = $3, latitude = NULL, longitude = NULL WHERE id = $1',
          [id, v.mode, v.mode === 'MANUELLE' ? v.ville : null],
        );
        await c.query(
          `UPDATE consentement SET revoque_le = now() WHERE utilisateur_id = $1 AND finalite = 'LOCALISATION' AND revoque_le IS NULL`,
          [id],
        );
      }
    });
    await this.audit.enregistrer(id, 'LOCALISATION_MODIFIEE', undefined, {
      mode: v.mode,
    });
  }

  async catalogue() {
    const { rows } = await this.db.query(
      `SELECT c.id, c.libelle, c.categorie_id AS "categorieId", k.libelle AS categorie
         FROM competence c JOIN categorie k ON k.id = c.categorie_id ORDER BY c.libelle`,
    );
    return rows;
  }

  async declarations(id: string) {
    const { rows } = await this.db.query(
      `SELECT competence_id AS "competenceId", sens, niveau, format, description, preuve_url AS "preuveUrl"
         FROM declaration_competence WHERE utilisateur_id = $1 ORDER BY sens, competence_id`,
      [id],
    );
    return rows;
  }

  async declarer(id: string, v: z.infer<typeof declarationSchema>) {
    try {
      await this.db.query(
        `INSERT INTO declaration_competence (utilisateur_id, competence_id, sens, niveau, format, description, preuve_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          v.competenceId,
          v.sens,
          v.niveau,
          v.format,
          v.description || null,
          v.preuveUrl || null,
        ],
      );
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505')
        throw new ErreurMetier('errors.dejaDeclaree', HttpStatus.CONFLICT); // RG3
      if (code === '23503')
        throw new ErreurMetier('errors.competence', HttpStatus.BAD_REQUEST);
      throw e;
    }
  }

  /** ES6 : la condition `utilisateur_id = $1` rend impossible de toucher à la déclaration d'un autre membre. */
  async retirer(id: string, competenceId: string) {
    const r = await this.db.query(
      'DELETE FROM declaration_competence WHERE utilisateur_id = $1 AND competence_id = $2',
      [id, competenceId],
    );
    if (r.rowCount === 0)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
  }
}
