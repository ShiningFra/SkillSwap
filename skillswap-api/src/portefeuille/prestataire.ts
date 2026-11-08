import { randomUUID } from 'node:crypto';

/**
 * Port vers le prestataire de paiement agréé (CinetPay ou Notchpay, CDC 4.1 bis). SkillSwap n'en est que client :
 * le prestataire détient l'argent réel. L'implémentation simulée sert au développement et aux démonstrations ;
 * une implémentation réelle remplace `PrestatairePaiement` dans PortefeuilleModule sans toucher au reste.
 */
export abstract class PrestatairePaiement {
  /** Vrai pour le faux prestataire : la page de confirmation simulée est alors proposée. */
  abstract readonly simule: boolean;
  /** Ouvre un encaissement ; renvoie la référence côté prestataire et l'adresse de la page de paiement hébergée. */
  abstract initierRecharge(p: {
    montant: number;
    operateur: string;
    numero: string;
  }): Promise<{ reference: string; urlPaiement: string }>;
  /** Exécute un transfert vers Mobile Money (API Transfert, distincte de l'encaissement). */
  abstract executerRetrait(p: {
    montant: number;
    operateur: string;
    numero: string;
  }): Promise<{ reference: string; reussi: boolean }>;
}

export class PrestataireSimule extends PrestatairePaiement {
  readonly simule = true;
  async initierRecharge() {
    const reference = `SIM-R-${randomUUID()}`;
    return { reference, urlPaiement: `/portefeuille/paiement?reference=${reference}` };
  }
  async executerRetrait() {
    return { reference: `SIM-T-${randomUUID()}`, reussi: true };
  }
}

/** Production sans prestataire configuré : aucune opération d'argent réel n'est possible. */
export class PrestataireAbsent extends PrestatairePaiement {
  readonly simule = false;
  async initierRecharge(): Promise<never> {
    throw new Error('Aucun prestataire de paiement configuré');
  }
  async executerRetrait(): Promise<never> {
    throw new Error('Aucun prestataire de paiement configuré');
  }
}
