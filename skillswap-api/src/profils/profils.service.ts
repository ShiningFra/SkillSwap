/* eslint-disable @typescript-eslint/no-unsafe-assignment -- lignes SQL aliasées, formes vérifiées par les tests e2e */
import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ErreurMetier, traduirePg } from '../common/erreurs';
import { Db } from '../db/db.service';
import { palierKm } from '../shared/domain';
import { creneauSchema, rechercheSchema } from '../shared/schemas';

const FORMAT_DATE = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Africa/Douala',
});

/** « Sam. 7 nov., 10 h » ou « Sam. 7 nov., 10 h 30 », dans le fuseau du Cameroun. */
export function libelleDate(d: Date): string {
  const p = Object.fromEntries(
    FORMAT_DATE.formatToParts(d).map((x) => [x.type, x.value]),
  );
  const jour = p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1);
  const heure = p.minute === '00' ? `${p.hour} h` : `${p.hour} h ${p.minute}`;
  return `${jour} ${p.day} ${p.month}, ${heure}`;
}

@Injectable()
export class ProfilsService {
  constructor(private readonly db: Db) {}

  /**
   * Recherche des membres qui offrent une compétence. ES8 : la distance est annoncée par paliers, le tri
   * se fait sur ce palier (et non sur la distance exacte) et aucune coordonnée n'est renvoyée.
   */
  async rechercher(moiId: string, q: z.infer<typeof rechercheSchema>) {
    const { rows } = await this.db.query(
      `SELECT u.id, u.pseudo, u.ville, (u.telephone_verifie_le IS NOT NULL) AS "telephoneVerifie",
              r.note_moyenne AS "noteMoyenne", COALESCE(r.nb_avis, 0)::int AS "nbAvis",
              d.competence_id AS "competenceId", d.niveau, d.format, (d.preuve_url IS NOT NULL) AS "preuveFournie",
              COALESCE(vc.confirmee, false) AS confirmee,
              CASE WHEN moi.mode_localisation = 'AUTOMATIQUE' AND u.mode_localisation = 'AUTOMATIQUE'
                   THEN distance_km(moi.latitude::float8, moi.longitude::float8, u.latitude::float8, u.longitude::float8) END AS distance
         FROM declaration_competence d
         JOIN utilisateur u ON u.id = d.utilisateur_id AND u.statut = 'ACTIF'
         JOIN utilisateur moi ON moi.id = $1
         LEFT JOIN v_reputation r ON r.utilisateur_id = u.id
         LEFT JOIN v_competence_confirmee vc ON vc.utilisateur_id = d.utilisateur_id AND vc.competence_id = d.competence_id
        WHERE d.sens = 'OFFERTE' AND u.id <> $1
          AND ($2::uuid IS NULL OR d.competence_id = $2)
          AND ($3::text IS NULL OR d.format = 'LES_DEUX' OR d.format = $3)
        LIMIT 200`,
      [moiId, q.competenceId ?? null, q.format ?? null],
    );
    const parMembre = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      if (parMembre.has(r.id as string)) continue; // une ligne par membre : sa première offre correspondante
      parMembre.set(r.id as string, {
        id: r.id,
        pseudo: r.pseudo,
        ville: r.ville ?? undefined,
        distanceKm:
          r.distance === null ? undefined : palierKm(Number(r.distance)),
        telephoneVerifie: r.telephoneVerifie,
        noteMoyenne: r.noteMoyenne === null ? undefined : Number(r.noteMoyenne),
        nbAvis: r.nbAvis,
        offre: {
          competenceId: r.competenceId,
          niveau: r.niveau,
          format: r.format,
          preuveFournie: r.preuveFournie,
          confirmee: r.confirmee,
        },
      });
    }
    return [...parMembre.values()].sort(
      (a, b) =>
        ((a.distanceKm as number | undefined) ?? Infinity) -
          ((b.distanceKm as number | undefined) ?? Infinity) ||
        String(a.pseudo).localeCompare(String(b.pseudo)),
    );
  }

  /** Profil public : jamais d'e-mail, de téléphone ni de coordonnées (ES8, ES9). */
  async profil(moiId: string, id: string) {
    const { rows } = await this.db.query(
      `SELECT u.id, u.pseudo, u.ville, (u.telephone_verifie_le IS NOT NULL) AS "telephoneVerifie",
              r.note_moyenne AS "noteMoyenne", COALESCE(r.nb_avis, 0)::int AS "nbAvis",
              CASE WHEN moi.mode_localisation = 'AUTOMATIQUE' AND u.mode_localisation = 'AUTOMATIQUE'
                   THEN distance_km(moi.latitude::float8, moi.longitude::float8, u.latitude::float8, u.longitude::float8) END AS distance
         FROM utilisateur u JOIN utilisateur moi ON moi.id = $1 LEFT JOIN v_reputation r ON r.utilisateur_id = u.id
        WHERE u.id = $2 AND u.statut = 'ACTIF'`,
      [moiId, id],
    );
    const u = rows[0];
    if (!u) throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    const [offertes, recherchees, avis, creneaux] = await Promise.all([
      this.db.query(
        `SELECT d.competence_id AS "competenceId", d.niveau, d.format, d.preuve_url AS "preuveUrl",
                COALESCE(vc.nb_avis_apprenants, 0)::int AS "sessionsNotees", COALESCE(vc.note_moyenne, 0)::float8 AS "noteMoyenne",
                COALESCE(vc.confirmee, false) AS confirmee
           FROM declaration_competence d
           LEFT JOIN v_competence_confirmee vc ON vc.utilisateur_id = d.utilisateur_id AND vc.competence_id = d.competence_id
          WHERE d.utilisateur_id = $1 AND d.sens = 'OFFERTE'`,
        [id],
      ),
      this.db.query(
        `SELECT competence_id AS "competenceId" FROM declaration_competence WHERE utilisateur_id = $1 AND sens = 'RECHERCHEE'`,
        [id],
      ),
      this.db.query(
        `SELECT au.pseudo AS auteur, a.note, COALESCE(a.commentaire, '') AS commentaire
           FROM avis a JOIN utilisateur au ON au.id = a.auteur_id WHERE a.cible_id = $1 ORDER BY a.cree_le DESC LIMIT 5`,
        [id],
      ),
      this.creneauxLibres(id),
    ]);
    return {
      id: u.id,
      pseudo: u.pseudo,
      ville: u.ville ?? undefined,
      distanceKm:
        u.distance === null ? undefined : palierKm(Number(u.distance)),
      telephoneVerifie: u.telephoneVerifie,
      noteMoyenne: u.noteMoyenne === null ? undefined : Number(u.noteMoyenne),
      nbAvis: u.nbAvis,
      offertes: offertes.rows.map((o) => ({
        ...o,
        preuveUrl: o.preuveUrl ?? undefined,
      })),
      recherchees: recherchees.rows.map((r) => r.competenceId as string),
      avis: avis.rows,
      creneaux,
    };
  }

  async creneauxLibres(membreId: string) {
    const { rows } = await this.db.query(
      `SELECT id, debut, format FROM creneau WHERE utilisateur_id = $1 AND statut = 'LIBRE' AND debut > now() ORDER BY debut LIMIT 10`,
      [membreId],
    );
    return rows.map((c) => ({
      id: c.id as string,
      libelle: libelleDate(c.debut as Date),
      format: c.format as string,
    }));
  }

  async creerCreneau(moiId: string, v: z.infer<typeof creneauSchema>) {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO creneau (utilisateur_id, debut, fin, format, prix_indicatif) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [moiId, v.debut, v.fin, v.format, v.prixIndicatif ?? null],
      );
      return { id: rows[0].id as string };
    } catch (e) {
      return traduirePg(e);
    }
  }

  async mesCreneaux(moiId: string) {
    const { rows } = await this.db.query(
      `SELECT id, debut, fin, format, prix_indicatif AS "prixIndicatif", statut FROM creneau WHERE utilisateur_id = $1 AND statut <> 'ANNULE' ORDER BY debut`,
      [moiId],
    );
    return rows;
  }
}
