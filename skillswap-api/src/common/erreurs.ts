import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodType } from 'zod';

/**
 * Erreur métier portant une clé de traduction (section « errors » de messages/fr.json du frontend).
 * Le message ne détaille jamais plus que la clé (ES3 : pas d'indice sur l'existence d'un compte).
 */
export class ErreurMetier extends HttpException {
  constructor(
    public readonly cle: string,
    statut: HttpStatus,
  ) {
    super({ cle }, statut);
  }
}

/** ES7 : validation côté serveur avec les mêmes schémas que les formulaires. */
export function valider<T>(schema: ZodType<T>, corps: unknown): T {
  const resultat = schema.safeParse(corps);
  if (resultat.success) return resultat.data;
  const champs: Record<string, string> = {};
  for (const issue of resultat.error.issues) {
    const chemin = issue.path.join('.') || '_';
    champs[chemin] ??= issue.message.startsWith('errors.')
      ? issue.message
      : 'errors.invalide';
  }
  throw new HttpException(
    { cle: 'errors.invalide', champs },
    HttpStatus.BAD_REQUEST,
  );
}

/** Convertit en erreur métier les violations de règles levées par les déclencheurs et contraintes de la base. */
export function traduirePg(e: unknown): never {
  const err = e as { code?: string; message?: string; constraint?: string };
  const m = err.message ?? '';
  if (err.code === '23514') {
    if (m.includes('RG17') || m.includes('téléphone non vérifié'))
      throw new ErreurMetier('errors.telephoneRequis', HttpStatus.FORBIDDEN);
    if (m.includes('compétence'))
      throw new ErreurMetier('errors.competence', HttpStatus.BAD_REQUEST);
    if (m.includes('créneau'))
      throw new ErreurMetier('errors.creneau', HttpStatus.BAD_REQUEST);
    if (m.includes('pas réalisée'))
      throw new ErreurMetier('errors.sessionPasRealisee', HttpStatus.CONFLICT);
  }
  if (err.code === '23P01')
    throw new ErreurMetier('errors.creneauChevauche', HttpStatus.CONFLICT); // RG6
  throw e;
}

/** Identifiant d'URL invalide : on répond « introuvable », sans détail. */
export function uuidOuIntrouvable(id: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
  return id;
}
