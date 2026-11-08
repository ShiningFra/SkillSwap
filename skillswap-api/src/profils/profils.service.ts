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

  /** Palier de distance (ES8) calculé en SQL pour trier et paginer sans jamais exposer la distance exacte. */
  private static readonly PALIER_SQL = `CASE WHEN dist IS NULL THEN NULL WHEN dist <= 1 THEN 1 WHEN dist <= 2 THEN 2 WHEN dist <= 5 THEN 5
    WHEN dist <= 10 THEN 10 WHEN dist <= 20 THEN 20 WHEN dist <= 50 THEN 50 WHEN dist <= 100 THEN 100 ELSE 200 END`;

  private static readonly DISTANCE_SQL = `CASE WHEN moi.mode_localisation = 'AUTOMATIQUE' AND u.mode_localisation = 'AUTOMATIQUE'
    THEN distance_km(moi.latitude::float8, moi.longitude::float8, u.latitude::float8, u.longitude::float8) END`;

  /** Détail des offres (et des demandes recoupant les miennes) pour une page de membres. */
  private async fiches(
    moiId: string,
    ids: string[],
    offresUtiles: string[] | null,
    format: string | null,
  ) {
    const { rows } = await this.db.query(
      `SELECT d.utilisateur_id AS "membreId", d.competence_id AS "competenceId", d.niveau, d.format,
              (d.preuve_url IS NOT NULL) AS "preuveFournie", COALESCE(vc.confirmee, false) AS confirmee
         FROM declaration_competence d
         LEFT JOIN v_competence_confirmee vc ON vc.utilisateur_id = d.utilisateur_id AND vc.competence_id = d.competence_id
        WHERE d.sens = 'OFFERTE' AND d.utilisateur_id = ANY($1::uuid[])
          AND ($2::uuid[] IS NULL OR d.competence_id = ANY($2::uuid[]))
          AND ($3::text IS NULL OR d.format = 'LES_DEUX' OR d.format = $3)
        ORDER BY d.competence_id`,
      [ids, offresUtiles, format],
    );
    const { rows: recip } = await this.db.query(
      `SELECT x.utilisateur_id AS "membreId", array_agg(DISTINCT x.competence_id) AS ids
         FROM declaration_competence x
         JOIN declaration_competence mo ON mo.competence_id = x.competence_id AND mo.utilisateur_id = $1 AND mo.sens = 'OFFERTE'
        WHERE x.sens = 'RECHERCHEE' AND x.utilisateur_id = ANY($2::uuid[])
        GROUP BY x.utilisateur_id`,
      [moiId, ids],
    );
    const parMembre = new Map<string, unknown[]>();
    for (const r of rows) {
      const l = parMembre.get(r.membreId) ?? [];
      l.push({
        competenceId: r.competenceId,
        niveau: r.niveau,
        format: r.format,
        preuveFournie: r.preuveFournie,
        confirmee: r.confirmee,
      });
      parMembre.set(r.membreId, l);
    }
    const reciproques = new Map<string, string[]>(
      recip.map((r: { membreId: string; ids: string[] }) => [
        r.membreId,
        r.ids,
      ]),
    );
    return { parMembre, reciproques };
  }

  private fiche(
    r: Record<string, unknown>,
    offres: unknown[] | undefined,
    reciproques: string[] | undefined,
    extra: Record<string, unknown> = {},
  ) {
    return {
      id: r.id,
      pseudo: r.pseudo,
      ville: r.ville ?? undefined,
      distanceKm: r.palier === null ? undefined : Number(r.palier),
      telephoneVerifie: r.telephoneVerifie,
      noteMoyenne: r.noteMoyenne === null ? undefined : Number(r.noteMoyenne),
      nbAvis: r.nbAvis,
      offres: offres ?? [],
      // Compétences que ce membre cherche et que je propose : base de la phrase de réciprocité.
      reciproques: reciproques ?? [],
      ...extra,
    };
  }

  /**
   * Recherche des membres qui offrent une ou plusieurs compétences (le front envoie toutes les compétences proches du
   * texte tapé en une seule requête). ES8 : distance annoncée par paliers, tri sur le palier, aucune coordonnée renvoyée.
   * Triée et paginée en base : `suite` indique qu'il y a d'autres résultats.
   */
  async rechercher(moiId: string, q: z.infer<typeof rechercheSchema>) {
    const ids = q.competenceIds ?? (q.competenceId ? [q.competenceId] : null);
    const { rows } = await this.db.query(
      `SELECT * FROM (
         SELECT u.id, u.pseudo, u.ville, (u.telephone_verifie_le IS NOT NULL) AS "telephoneVerifie",
                r.note_moyenne AS "noteMoyenne", COALESCE(r.nb_avis, 0)::int AS "nbAvis",
                ${ProfilsService.DISTANCE_SQL} AS dist
           FROM utilisateur u
           JOIN utilisateur moi ON moi.id = $1
           LEFT JOIN v_reputation r ON r.utilisateur_id = u.id
          WHERE u.statut = 'ACTIF' AND u.id <> $1
            AND EXISTS (SELECT 1 FROM declaration_competence d
                         WHERE d.utilisateur_id = u.id AND d.sens = 'OFFERTE'
                           AND ($2::uuid[] IS NULL OR d.competence_id = ANY($2::uuid[]))
                           AND ($3::text IS NULL OR d.format = 'LES_DEUX' OR d.format = $3))
       ) t
       CROSS JOIN LATERAL (SELECT ${ProfilsService.PALIER_SQL.replaceAll('dist', 't.dist')} AS palier) p
       ORDER BY p.palier NULLS LAST, t."noteMoyenne" DESC NULLS LAST, t.pseudo, t.id
       LIMIT $4 OFFSET $5`,
      [moiId, ids, q.format ?? null, q.limite + 1, q.decalage],
    );
    const page = rows.slice(0, q.limite);
    const { parMembre, reciproques } = await this.fiches(
      moiId,
      page.map((r: { id: string }) => r.id),
      ids,
      q.format ?? null,
    );
    return {
      resultats: page.map((r: Record<string, unknown>) =>
        this.fiche(
          r,
          parMembre.get(r.id as string),
          reciproques.get(r.id as string),
        ),
      ),
      suite: rows.length > q.limite,
    };
  }

  /**
   * Suggestions de l'accueil, par pertinence : d'abord les échanges réciproques (ils offrent ce que je cherche ET
   * cherchent ce que j'offre), puis ceux qui offrent ce que je cherche, puis ceux qui cherchent ce que j'offre ;
   * à égalité, les plus proches et les mieux notés. Sans rien de déclaré, les membres les plus proches.
   */
  async suggerer(moiId: string, q: { limite: number; decalage: number }) {
    const { rows: mes } = await this.db.query(
      `SELECT sens, array_agg(competence_id) AS ids FROM declaration_competence WHERE utilisateur_id = $1 GROUP BY sens`,
      [moiId],
    );
    const cherche: string[] =
      mes.find((m: { sens: string }) => m.sens === 'RECHERCHEE')?.ids ?? [];
    const offre: string[] =
      mes.find((m: { sens: string }) => m.sens === 'OFFERTE')?.ids ?? [];
    if (cherche.length === 0 && offre.length === 0) {
      const base = await this.rechercher(moiId, { ...q });
      return {
        ...base,
        resultats: base.resultats.map((f) => ({ ...f, raison: 'proximite' })),
      };
    }
    const { rows } = await this.db.query(
      `SELECT t.*, p.palier FROM (
         SELECT u.id, u.pseudo, u.ville, (u.telephone_verifie_le IS NOT NULL) AS "telephoneVerifie",
                r.note_moyenne AS "noteMoyenne", COALESCE(r.nb_avis, 0)::int AS "nbAvis",
                ${ProfilsService.DISTANCE_SQL} AS dist,
                EXISTS (SELECT 1 FROM declaration_competence d WHERE d.utilisateur_id = u.id AND d.sens = 'OFFERTE'
                          AND d.competence_id = ANY($2::uuid[])) AS "offreUtile",
                EXISTS (SELECT 1 FROM declaration_competence x WHERE x.utilisateur_id = u.id AND x.sens = 'RECHERCHEE'
                          AND x.competence_id = ANY($3::uuid[])) AS "veutMonOffre"
           FROM utilisateur u
           JOIN utilisateur moi ON moi.id = $1
           LEFT JOIN v_reputation r ON r.utilisateur_id = u.id
          WHERE u.statut = 'ACTIF' AND u.id <> $1
       ) t
       CROSS JOIN LATERAL (SELECT ${ProfilsService.PALIER_SQL.replaceAll('dist', 't.dist')} AS palier) p
       WHERE t."offreUtile" OR t."veutMonOffre"
       ORDER BY (t."offreUtile" AND t."veutMonOffre") DESC, t."offreUtile" DESC, p.palier NULLS LAST,
                t."noteMoyenne" DESC NULLS LAST, t.pseudo, t.id
       LIMIT $4 OFFSET $5`,
      [moiId, cherche, offre, q.limite + 1, q.decalage],
    );
    const page = rows.slice(0, q.limite);
    const { parMembre, reciproques } = await this.fiches(
      moiId,
      page.map((r: { id: string }) => r.id),
      cherche,
      null,
    );
    return {
      resultats: page.map((r: Record<string, unknown>) =>
        this.fiche(
          r,
          parMembre.get(r.id as string),
          reciproques.get(r.id as string),
          {
            raison:
              r.offreUtile && r.veutMonOffre
                ? 'mutuel'
                : r.offreUtile
                  ? 'offre'
                  : 'demande',
          },
        ),
      ),
      suite: rows.length > q.limite,
    };
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

  /** Créneaux à venir du membre, avec un libellé prêt à afficher (fuseau du Cameroun). */
  async mesCreneaux(moiId: string) {
    const { rows } = await this.db.query<{
      id: string;
      debut: Date;
      fin: Date;
      format: string;
      prixIndicatif: number | null;
      statut: string;
    }>(
      `SELECT id, debut, fin, format, prix_indicatif AS "prixIndicatif", statut FROM creneau
        WHERE utilisateur_id = $1 AND statut <> 'ANNULE' AND fin > now() ORDER BY debut`,
      [moiId],
    );
    return rows.map((c) => ({ ...c, libelle: libelleDate(c.debut) }));
  }

  /** Un créneau libre s'annule ; un créneau réservé par une session doit d'abord être traité par la session. */
  async annulerCreneau(moiId: string, id: string) {
    const r = await this.db.query<{ statut: string }>(
      `UPDATE creneau SET statut = 'ANNULE' WHERE id = $1 AND utilisateur_id = $2 AND statut = 'LIBRE' RETURNING statut`,
      [id, moiId],
    );
    if (r.rowCount === 1) return;
    const existe = await this.db.query(
      `SELECT 1 FROM creneau WHERE id = $1 AND utilisateur_id = $2 AND statut = 'RESERVE'`,
      [id, moiId],
    );
    if (existe.rowCount === 1)
      throw new ErreurMetier('errors.creneauReserve', HttpStatus.CONFLICT);
    throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
  }
}
