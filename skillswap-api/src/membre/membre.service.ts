import { ParametresService } from '../parametres/parametres.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';
import {
  declarationSchema,
  localisationSchema,
  modificationCompetenceSchema,
  profilSchema,
} from '../shared/schemas';

@Injectable()
export class MembreService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly parametres: ParametresService,
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
      `SELECT c.id, c.libelle, c.synonymes, c.categorie_id AS "categorieId", k.libelle AS categorie
         FROM competence c JOIN categorie k ON k.id = c.categorie_id ORDER BY c.libelle`,
    );
    return rows;
  }

  /**
   * Un membre propose une compétence absente du catalogue. Anti-doublon : on compare sans accents,
   * sans casse ni ponctuation, au libellé comme aux synonymes ; en cas de proximité on renvoie l'existante.
   */
  async proposerCompetence(
    id: string,
    v: { libelle: string; categorieId: string },
  ) {
    await this.parametres.exiger('propositions_competences');
    const cle = (t: string) =>
      t
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const voulu = cle(v.libelle);
    if (voulu.length < 2)
      throw new ErreurMetier('errors.competence', HttpStatus.BAD_REQUEST);
    const { rows: cat } = await this.db.query(
      'SELECT 1 FROM categorie WHERE id = $1',
      [v.categorieId],
    );
    if (!cat.length)
      throw new ErreurMetier('errors.competence', HttpStatus.BAD_REQUEST);
    const { rows: recentes } = await this.db.query(
      `SELECT count(*)::int AS n FROM competence WHERE cree_par = $1 AND cree_le > now() - interval '1 day'`,
      [id],
    );
    if (recentes[0].n >= 5)
      throw new ErreurMetier(
        'errors.tropDePropositions',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const { rows } = await this.db.query(
      `SELECT c.id, c.libelle, c.synonymes, c.categorie_id AS "categorieId", k.libelle AS categorie
         FROM competence c JOIN categorie k ON k.id = c.categorie_id`,
    );
    const existante = rows.find(
      (r: { libelle: string; synonymes: string }) =>
        cle(r.libelle) === voulu ||
        r.synonymes.split(';').some((x: string) => cle(x) === voulu),
    );
    if (existante) return { ...existante, existait: true };
    const { rows: neuve } = await this.db.query(
      `INSERT INTO competence (libelle, categorie_id, cree_par) VALUES ($1, $2, $3) RETURNING id`,
      [v.libelle, v.categorieId, id],
    );
    await this.audit.enregistrer(id, 'COMPETENCE_PROPOSEE', neuve[0].id, {
      libelle: v.libelle,
    });
    const { rows: c } = await this.db.query(
      `SELECT c.id, c.libelle, c.synonymes, c.categorie_id AS "categorieId", k.libelle AS categorie
         FROM competence c JOIN categorie k ON k.id = c.categorie_id WHERE c.id = $1`,
      [neuve[0].id],
    );
    return { ...c[0], existait: false };
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

  /** Modifie le niveau, le format ou le lien de preuve d'une déclaration existante (RG18 : preuve seulement sur une offre). */
  async modifierCompetence(
    id: string,
    competenceId: string,
    v: z.infer<typeof modificationCompetenceSchema>,
  ) {
    const actuelle = await this.db.query<{ sens: string }>(
      'SELECT sens FROM declaration_competence WHERE utilisateur_id = $1 AND competence_id = $2',
      [id, competenceId],
    );
    if (!actuelle.rows[0])
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    if (v.preuveUrl && actuelle.rows[0].sens !== 'OFFERTE')
      throw new ErreurMetier(
        'errors.preuveSeulementOfferte',
        HttpStatus.BAD_REQUEST,
      );
    await this.db.query(
      `UPDATE declaration_competence SET niveau = $3, format = $4, description = $5, preuve_url = $6
        WHERE utilisateur_id = $1 AND competence_id = $2`,
      [
        id,
        competenceId,
        v.niveau,
        v.format,
        v.description || null,
        v.preuveUrl || null,
      ],
    );
  }

  /** Pseudo et bio toujours ; la ville seulement en localisation manuelle (RG5 : pas de ville en mode automatique). */
  async modifierProfil(id: string, v: z.infer<typeof profilSchema>) {
    const { rows } = await this.db.query<{ mode: string }>(
      `SELECT mode_localisation AS mode FROM utilisateur WHERE id = $1`,
      [id],
    );
    const manuel = rows[0]?.mode === 'MANUELLE';
    await this.db.query(
      `UPDATE utilisateur SET pseudo = $2, bio = $3, ville = CASE WHEN $5 THEN $4 ELSE ville END WHERE id = $1`,
      [id, v.pseudo, v.bio || null, v.ville || null, manuel],
    );
    await this.audit.enregistrer(id, 'PROFIL_MODIFIE');
  }
}
