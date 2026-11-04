/**
 * Schémas partagés avec le frontend (copie de skillswap-web/src/lib/schemas.ts pour les formulaires
 * communs ; à mutualiser dans un paquet commun quand le dépôt sera un monorepo).
 * Les messages sont des clés de traduction.
 */
import { z } from 'zod';
import {
  CODE_SMS,
  CONTREPARTIES,
  FORMATS,
  MOTIFS_SIGNALEMENT,
  NIVEAUX,
  SENS_COMPETENCE,
  TYPES_LIEU,
} from './domain';

export const TELEPHONE = /^\+[0-9]{8,15}$/;

export const inscriptionSchema = z.object({
  email: z.email({ error: 'errors.email' }).max(254, { error: 'errors.email' }),
  pseudo: z
    .string()
    .trim()
    .min(2, { error: 'errors.pseudo' })
    .max(40, { error: 'errors.pseudo' }),
  motDePasse: z
    .string()
    .min(10, { error: 'errors.motDePasse' })
    .max(128, { error: 'errors.motDePasse' }),
  majeur: z.literal(true, { error: 'errors.majeur' }),
  cgu: z.literal(true, { error: 'errors.cgu' }),
});

export const connexionSchema = z.object({
  email: z.string().max(254, { error: 'errors.invalide' }),
  motDePasse: z.string().max(128, { error: 'errors.invalide' }),
});

export const telephoneSchema = z.object({
  telephone: z.string().trim().regex(TELEPHONE, { error: 'errors.telephone' }),
});
export const codeSmsSchema = z.object({
  code: z.string().regex(new RegExp(`^[0-9]{${CODE_SMS.longueur}}$`), {
    error: 'errors.code',
  }),
});

/** Version serveur : le mode AUTOMATIQUE porte les coordonnées (RG5), qui ne sont jamais renvoyées par l'API. */
export const localisationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('AUCUNE') }),
  z.object({
    mode: z.literal('MANUELLE'),
    ville: z
      .string()
      .trim()
      .min(2, { error: 'errors.ville' })
      .max(80, { error: 'errors.ville' }),
  }),
  z.object({
    mode: z.literal('AUTOMATIQUE'),
    consentement: z.literal(true, { error: 'errors.consentement' }),
    latitude: z.number({ error: 'errors.invalide' }).min(-90).max(90),
    longitude: z.number({ error: 'errors.invalide' }).min(-180).max(180),
  }),
]);

const lienWeb = z
  .string()
  .trim()
  .max(500, { error: 'errors.lien' })
  .refine((v) => /^https?:\/\/\S+$/i.test(v), { error: 'errors.lien' });

export const declarationSchema = z
  .object({
    competenceId: z.uuid({ error: 'errors.competence' }),
    sens: z.enum(SENS_COMPETENCE),
    niveau: z.enum(NIVEAUX),
    format: z.enum(FORMATS),
    description: z.string().trim().max(500).optional(),
    preuveUrl: z.union([lienWeb, z.literal('')]).optional(),
  })
  .refine((v) => !v.preuveUrl || v.sens === 'OFFERTE', {
    error: 'errors.preuveSeulementOfferte',
    path: ['preuveUrl'],
  });

// ---------------------------------------------------------------------------
// Lot 2 : recherche, créneaux, conversations, sessions, avis, signalements
// ---------------------------------------------------------------------------
export const rechercheSchema = z.object({
  competenceId: z.uuid({ error: 'errors.competence' }).optional(),
  format: z.enum(['PRESENTIEL', 'DISTANCE']).optional(),
});

/** RG6 : un créneau se termine après son début ; il se publie dans le futur. */
export const creneauSchema = z
  .object({
    debut: z.iso.datetime({ offset: true, error: 'errors.creneau' }),
    fin: z.iso.datetime({ offset: true, error: 'errors.creneau' }),
    format: z.enum(FORMATS),
    prixIndicatif: z.number().int().min(0).max(10_000_000).optional(),
  })
  .refine((v) => new Date(v.fin) > new Date(v.debut), {
    error: 'errors.creneau',
    path: ['fin'],
  })
  .refine((v) => new Date(v.debut) > new Date(), {
    error: 'errors.creneau',
    path: ['debut'],
  });

export const ouvertureConversationSchema = z.object({
  membreId: z.uuid({ error: 'errors.introuvable' }),
});
export const messageSchema = z.object({
  texte: z
    .string()
    .trim()
    .min(1, { error: 'errors.message' })
    .max(1000, { error: 'errors.message' }),
});

/** RG16 : contrepartie toujours choisie. RG20 : un lieu seulement en présentiel, et alors obligatoire. */
export const propositionSchema = z
  .object({
    creneauId: z.uuid({ error: 'errors.creneau' }),
    competenceId: z.uuid({ error: 'errors.competence' }).optional(),
    format: z.enum(['PRESENTIEL', 'DISTANCE']),
    lieuType: z.enum(TYPES_LIEU).optional(),
    contrepartie: z.enum(CONTREPARTIES, { error: 'errors.contrepartie' }),
  })
  .superRefine((v, ctx) => {
    if (v.format === 'PRESENTIEL' && !v.lieuType)
      ctx.addIssue({
        code: 'custom',
        path: ['lieuType'],
        message: 'errors.lieu',
      });
    if (v.format === 'DISTANCE' && v.lieuType)
      ctx.addIssue({
        code: 'custom',
        path: ['lieuType'],
        message: 'errors.lieuDistance',
      });
  });

export const reponsePropositionSchema = z.object({
  accepter: z.boolean({ error: 'errors.invalide' }),
});

export const avisSchema = z.object({
  note: z
    .number({ error: 'errors.note' })
    .int({ error: 'errors.note' })
    .min(1, { error: 'errors.note' })
    .max(5, { error: 'errors.note' }),
  commentaire: z
    .string()
    .trim()
    .max(500, { error: 'errors.commentaire' })
    .optional(),
});

export const signalementSchema = z.object({
  membreId: z.uuid({ error: 'errors.introuvable' }),
  motif: z.enum(MOTIFS_SIGNALEMENT, { error: 'errors.motif' }),
  description: z
    .string()
    .trim()
    .max(500, { error: 'errors.commentaire' })
    .optional(),
});
