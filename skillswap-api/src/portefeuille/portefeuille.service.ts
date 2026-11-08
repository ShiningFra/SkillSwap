import { HttpStatus, Injectable } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';
import { ParametresService } from '../parametres/parametres.service';
import { PORTEFEUILLE } from '../shared/domain';
import { ecrire } from './grand-livre';
import { PrestatairePaiement } from './prestataire';

interface LigneTx {
  id: string;
  utilisateur_id: string;
  sens: 'RECHARGE' | 'RETRAIT';
  montant: string;
  statut: string;
}

/** 6 12 34 56 78 → « 6•• ••• •78 » : le numéro complet n'est jamais conservé. */
const masquer = (n: string) => `${n[0]}•• ••• •${n.slice(-2)}`;

@Injectable()
export class PortefeuilleService {
  constructor(
    private readonly db: Db,
    private readonly parametres: ParametresService,
    private readonly prestataire: PrestatairePaiement,
    private readonly audit: Audit,
  ) {}

  async solde(moiId: string) {
    const { rows } = await this.db.query<{ d: string; s: string }>(
      'SELECT disponible::text AS d, sequestre::text AS s FROM portefeuille WHERE utilisateur_id = $1',
      [moiId],
    );
    return {
      disponible: Number(rows[0]?.d ?? 0),
      sequestre: Number(rows[0]?.s ?? 0),
      plafond: PORTEFEUILLE.soldeMax,
      limites: {
        rechargeMin: PORTEFEUILLE.rechargeMin,
        rechargeMax: PORTEFEUILLE.rechargeMax,
        retraitMin: PORTEFEUILLE.retraitMin,
      },
      prestataireSimule: this.prestataire.simule,
    };
  }

  async historique(moiId: string, limite: number, decalage: number) {
    const { rows } = await this.db.query<{
      id: string;
      type: string;
      dd: string;
      ds: string;
      session_id: string | null;
      autre: string | null;
      cree_le: Date;
    }>(
      `SELECT e.id, e.type, e.delta_disponible::text AS dd, e.delta_sequestre::text AS ds, e.session_id, e.cree_le,
              o.pseudo AS autre
         FROM ecriture_portefeuille e
         LEFT JOIN session_echange s ON s.id = e.session_id
         LEFT JOIN utilisateur o ON o.id = CASE WHEN s.enseignant_id = e.utilisateur_id THEN s.apprenant_id ELSE s.enseignant_id END
        WHERE e.utilisateur_id = $1
        ORDER BY e.cree_le DESC, e.id LIMIT $2 OFFSET $3`,
      [moiId, limite + 1, decalage],
    );
    const page = rows.slice(0, limite);
    return {
      ecritures: page.map((r) => ({
        id: r.id,
        type: r.type,
        deltaDisponible: Number(r.dd),
        deltaSequestre: Number(r.ds),
        sessionId: r.session_id ?? undefined,
        autre: r.autre ?? undefined,
        date: r.cree_le,
      })),
      suite: rows.length > limite,
    };
  }

  /** Une recharge abandonnée depuis trop longtemps est close : elle ne bloque plus d'autre demande. */
  private async expirerAttentes(moiId: string) {
    await this.db.query(
      `UPDATE transaction_externe SET statut = 'ECHOUEE', termine_le = now()
        WHERE utilisateur_id = $1 AND sens = 'RECHARGE' AND statut = 'EN_ATTENTE'
          AND cree_le < now() - make_interval(mins => $2)`,
      [moiId, PORTEFEUILLE.attenteMinutes],
    );
  }

  async initierRecharge(
    moiId: string,
    v: { montant: number; operateur: string; numero: string },
  ) {
    await this.parametres.exiger('portefeuille');
    await this.expirerAttentes(moiId);
    const s = await this.solde(moiId);
    if (s.disponible + s.sequestre + v.montant > PORTEFEUILLE.soldeMax)
      throw new ErreurMetier('errors.plafondSolde', HttpStatus.CONFLICT);
    const attente = await this.db.query(
      `SELECT 1 FROM transaction_externe WHERE utilisateur_id = $1 AND sens = 'RECHARGE' AND statut = 'EN_ATTENTE'`,
      [moiId],
    );
    if (attente.rowCount)
      throw new ErreurMetier('errors.rechargeEnCours', HttpStatus.CONFLICT);
    let ouverte;
    try {
      ouverte = await this.prestataire.initierRecharge(v);
    } catch {
      throw new ErreurMetier(
        'errors.enRevision',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.db.query(
      `INSERT INTO transaction_externe (utilisateur_id, sens, montant, operateur, numero_masque, reference)
       VALUES ($1, 'RECHARGE', $2, $3, $4, $5)`,
      [moiId, v.montant, v.operateur, masquer(v.numero), ouverte.reference],
    );
    return ouverte;
  }

  async rechargeDe(moiId: string, reference: string) {
    const { rows } = await this.db.query<{
      montant: string;
      statut: string;
      operateur: string;
    }>(
      `SELECT montant::text, statut, operateur FROM transaction_externe WHERE reference = $1 AND utilisateur_id = $2 AND sens = 'RECHARGE'`,
      [reference, moiId],
    );
    if (!rows[0])
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    return {
      montant: Number(rows[0].montant),
      statut: rows[0].statut,
      operateur: rows[0].operateur,
    };
  }

  /**
   * Résultat d'un encaissement, tel que le notifierait le webhook du prestataire. Idempotent : un deuxième appel
   * pour la même référence ne crédite jamais deux fois (CDC, exigences v2.0).
   */
  async conclureRecharge(reference: string, reussie: boolean) {
    await this.db.transaction(async (c) => {
      const { rows } = await c.query<LigneTx>(
        `SELECT id, utilisateur_id, sens, montant::text, statut FROM transaction_externe
          WHERE reference = $1 AND sens = 'RECHARGE' FOR UPDATE`,
        [reference],
      );
      const t = rows[0];
      if (!t)
        throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
      if (t.statut !== 'EN_ATTENTE') return;
      await c.query(
        `UPDATE transaction_externe SET statut = $2, termine_le = now() WHERE id = $1`,
        [t.id, reussie ? 'REUSSIE' : 'ECHOUEE'],
      );
      if (!reussie) return;
      await ecrire(c, {
        utilisateurId: t.utilisateur_id,
        type: 'RECHARGE',
        dDisponible: Number(t.montant),
        transactionId: t.id,
      });
      await c.query(
        `INSERT INTO notification (utilisateur_id, type, contenu, lien) VALUES ($1, 'RECHARGE_CONFIRMEE', 'Ton portefeuille a été rechargé', '/portefeuille')`,
        [t.utilisateur_id],
      );
    });
  }

  /** Simulation du webhook, réservée au propriétaire de la recharge et au faux prestataire. */
  async simuler(moiId: string, reference: string, reussie: boolean) {
    if (!this.prestataire.simule)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    await this.rechargeDe(moiId, reference);
    await this.conclureRecharge(reference, reussie);
  }

  /** Retrait vers Mobile Money : le solde est débité d'abord, puis rendu si le prestataire échoue. */
  async retirer(
    moiId: string,
    v: {
      montant: number;
      operateur: string;
      numero: string;
      motDePasse: string;
    },
  ) {
    await this.parametres.exiger('portefeuille');
    const h = await this.db.query<{ h: string }>(
      `SELECT mot_de_passe_hash AS h FROM utilisateur WHERE id = $1 AND statut = 'ACTIF'`,
      [moiId],
    );
    const ok = h.rows[0]
      ? await verify(h.rows[0].h, v.motDePasse).catch(() => false)
      : false;
    if (!ok)
      throw new ErreurMetier('errors.identifiants', HttpStatus.UNAUTHORIZED);

    const txId = await this.db.transaction(async (c) => {
      const reference = `EN-COURS-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const t = await c.query<{ id: string }>(
        `INSERT INTO transaction_externe (utilisateur_id, sens, montant, operateur, numero_masque, reference)
         VALUES ($1, 'RETRAIT', $2, $3, $4, $5) RETURNING id`,
        [moiId, v.montant, v.operateur, masquer(v.numero), reference],
      );
      await ecrire(c, {
        utilisateurId: moiId,
        type: 'RETRAIT',
        dDisponible: -v.montant,
        transactionId: t.rows[0].id,
      });
      return t.rows[0].id;
    });

    let reussi = false;
    let referencePrestataire: string | undefined;
    try {
      const r = await this.prestataire.executerRetrait(v);
      reussi = r.reussi;
      referencePrestataire = r.reference;
    } catch {
      reussi = false;
    }
    await this.db.transaction(async (c) => {
      await c.query(
        `UPDATE transaction_externe SET statut = $2, termine_le = now(), reference = COALESCE($3, reference) WHERE id = $1`,
        [txId, reussi ? 'REUSSIE' : 'ECHOUEE', referencePrestataire ?? null],
      );
      if (!reussi)
        await ecrire(c, {
          utilisateurId: moiId,
          type: 'RETRAIT_ANNULE',
          dDisponible: v.montant,
          transactionId: txId,
        });
    });
    await this.audit.enregistrer(moiId, 'RETRAIT_PORTEFEUILLE', txId, {
      montant: v.montant,
      reussi,
    });
    if (!reussi)
      throw new ErreurMetier('errors.retraitEchoue', HttpStatus.BAD_GATEWAY);
  }
}
