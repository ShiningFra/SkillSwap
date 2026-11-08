import { HttpStatus } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ErreurMetier } from '../common/erreurs';

/**
 * Grand livre du portefeuille (Lot 1bis). Toute variation de solde passe par `ecrire`, dans la transaction de
 * l'opération qui la cause : le solde et le grand livre ne peuvent pas diverger. Les montants sont en FCFA entiers.
 * Ces fonctions n'ont pas de dépendance injectée : sessions, suppression de compte et administration s'en servent.
 */
export type TypeEcriture =
  | 'RECHARGE'
  | 'RETRAIT'
  | 'RETRAIT_ANNULE'
  | 'SEQUESTRE'
  | 'LIBERATION'
  | 'RECEPTION'
  | 'REMBOURSEMENT';

export interface SessionPayee {
  id: string;
  apprenant_id: string;
  enseignant_id: string;
  prix: number | null;
}

export async function ecrire(
  c: PoolClient,
  e: {
    utilisateurId: string;
    type: TypeEcriture;
    dDisponible?: number;
    dSequestre?: number;
    sessionId?: string;
    transactionId?: string;
  },
) {
  const dd = e.dDisponible ?? 0;
  const ds = e.dSequestre ?? 0;
  await c.query(
    'INSERT INTO portefeuille (utilisateur_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [e.utilisateurId],
  );
  try {
    await c.query(
      `UPDATE portefeuille SET disponible = disponible + $2, sequestre = sequestre + $3, maj_le = now()
        WHERE utilisateur_id = $1`,
      [e.utilisateurId, dd, ds],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23514')
      throw new ErreurMetier('errors.soldeInsuffisant', HttpStatus.CONFLICT);
    throw err;
  }
  await c.query(
    `INSERT INTO ecriture_portefeuille (utilisateur_id, type, delta_disponible, delta_sequestre, session_id, transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.utilisateurId,
      e.type,
      dd,
      ds,
      e.sessionId ?? null,
      e.transactionId ?? null,
    ],
  );
}

function notifier(
  c: PoolClient,
  utilisateurId: string,
  type: string,
  contenu: string,
  lien: string,
) {
  return c.query(
    'INSERT INTO notification (utilisateur_id, type, contenu, lien) VALUES ($1, $2, $3, $4)',
    [utilisateurId, type, contenu, lien],
  );
}

/** À l'acceptation : le prix quitte le solde disponible de l'apprenant et passe en séquestre. */
export async function bloquerSequestre(c: PoolClient, s: SessionPayee) {
  if (!s.prix) return;
  try {
    await ecrire(c, {
      utilisateurId: s.apprenant_id,
      type: 'SEQUESTRE',
      dDisponible: -s.prix,
      dSequestre: s.prix,
      sessionId: s.id,
    });
  } catch (e) {
    if (e instanceof ErreurMetier && e.cle === 'errors.soldeInsuffisant')
      throw new ErreurMetier('errors.soldeApprenant', HttpStatus.CONFLICT);
    throw e;
  }
  await c.query(
    `UPDATE session_echange SET paiement = 'SEQUESTRE' WHERE id = $1`,
    [s.id],
  );
  await notifier(
    c,
    s.apprenant_id,
    'PAIEMENT_SEQUESTRE',
    'Le prix de ta session est mis en réserve',
    `/sessions/${s.id}`,
  );
}

/** Session réalisée : le séquestre de l'apprenant est versé à l'enseignant. */
export async function libererSequestre(c: PoolClient, s: SessionPayee) {
  if (!s.prix) return;
  await ecrire(c, {
    utilisateurId: s.apprenant_id,
    type: 'LIBERATION',
    dSequestre: -s.prix,
    sessionId: s.id,
  });
  await ecrire(c, {
    utilisateurId: s.enseignant_id,
    type: 'RECEPTION',
    dDisponible: s.prix,
    sessionId: s.id,
  });
  await c.query(
    `UPDATE session_echange SET paiement = 'LIBERE' WHERE id = $1`,
    [s.id],
  );
  await notifier(
    c,
    s.enseignant_id,
    'PAIEMENT_RECU',
    'Tu as reçu le paiement d’une session',
    `/sessions/${s.id}`,
  );
}

/** Session non réalisée ou annulée : le séquestre retourne au solde disponible de l'apprenant. */
export async function rembourserSequestre(c: PoolClient, s: SessionPayee) {
  if (!s.prix) return;
  await ecrire(c, {
    utilisateurId: s.apprenant_id,
    type: 'REMBOURSEMENT',
    dDisponible: s.prix,
    dSequestre: -s.prix,
    sessionId: s.id,
  });
  await c.query(
    `UPDATE session_echange SET paiement = 'REMBOURSE' WHERE id = $1`,
    [s.id],
  );
  await notifier(
    c,
    s.apprenant_id,
    'PAIEMENT_REMBOURSE',
    'Le prix de ta session t’a été rendu',
    `/sessions/${s.id}`,
  );
}
