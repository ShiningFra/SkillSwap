import { ParametresService } from '../parametres/parametres.service';
import { Injectable, Logger } from '@nestjs/common';
import { Db } from '../db/db.service';

/** E5 compresse les similarités autour de 0,8 : seuls les scores nettement au-dessus comptent (réglé sur le catalogue). */
const SEUIL_MIN = 0.835;
const ECART_MAX = 0.03;
const MAX_RESULTATS = 6;

export interface Candidat {
  id: string;
  vecteur: number[];
}

/** Vecteurs normalisés : le produit scalaire est la similarité cosinus. */
export function classerParSimilarite(requete: number[], candidats: Candidat[]) {
  const notes = candidats
    .map((c) => ({
      id: c.id,
      score: c.vecteur.reduce((a, x, i) => a + x * requete[i], 0),
    }))
    .sort((a, b) => b.score - a.score);
  const meilleur = notes[0]?.score ?? 0;
  if (meilleur < SEUIL_MIN) return [];
  return notes
    .filter((n) => n.score >= SEUIL_MIN && n.score >= meilleur - ECART_MAX)
    .slice(0, MAX_RESULTATS)
    .map((n) => ({ id: n.id, score: Math.round(n.score * 1000) / 1000 }));
}

type Extracteur = (
  textes: string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ tolist(): number[][] }>;

/**
 * Recherche par le sens (« faire des gâteaux » → Pâtisserie) avec multilingual-e5-small, exécuté dans l'API :
 * aucun service externe. Le modèle se charge à la première requête ; s'il est indisponible, la fonction se
 * désactive sans gêner le reste (l'application garde sa recherche tolérante aux fautes).
 * EMBEDDINGS_DISABLED=true la coupe ; EMBEDDINGS_DIR pointe vers une copie locale du modèle (sinon téléchargement unique).
 */
@Injectable()
export class SemantiqueService {
  private readonly journal = new Logger(SemantiqueService.name);
  private extracteur?: Promise<Extracteur | null>;
  private vecteurs?: Promise<Candidat[]>;
  private vecteursCle = '';

  constructor(
    private readonly db: Db,
    private readonly parametres: ParametresService,
  ) {}

  private actif() {
    return process.env.EMBEDDINGS_DISABLED !== 'true';
  }

  private charger(): Promise<Extracteur | null> {
    this.extracteur ??= (async () => {
      try {
        // Import dynamique : le paquet est en ESM pur.
        const { pipeline, env } = (await new Function('m', 'return import(m)')(
          '@huggingface/transformers',
        )) as typeof import('@huggingface/transformers');
        if (process.env.EMBEDDINGS_DIR) {
          env.localModelPath = process.env.EMBEDDINGS_DIR;
          env.allowRemoteModels = false;
        }
        const ex = await pipeline(
          'feature-extraction',
          'Xenova/multilingual-e5-small',
          { dtype: 'q8' },
        );
        return ex as unknown as Extracteur;
      } catch (e) {
        this.journal.warn(
          `Recherche sémantique indisponible : ${(e as Error).message}`,
        );
        return null;
      }
    })();
    return this.extracteur;
  }

  private async encoder(textes: string[]) {
    const ex = await this.charger();
    if (!ex) return null;
    return (await ex(textes, { pooling: 'mean', normalize: true })).tolist();
  }

  /** Vecteurs du catalogue, recalculés seulement si le catalogue a changé. */
  private async catalogue(): Promise<Candidat[]> {
    const { rows } = await this.db.query(
      'SELECT id, libelle, synonymes FROM competence ORDER BY id',
    );
    const cle = rows
      .map(
        (r: { id: string; libelle: string; synonymes: string }) =>
          `${r.id}${r.libelle}${r.synonymes}`,
      )
      .join('|');
    if (!this.vecteurs || cle !== this.vecteursCle) {
      this.vecteursCle = cle;
      this.vecteurs = (async () => {
        const textes = rows.map(
          (r: { libelle: string; synonymes: string }) =>
            `passage: ${r.libelle}${r.synonymes ? ` (${r.synonymes.split(';').join(', ')})` : ''}`,
        );
        const v = await this.encoder(textes);
        return v
          ? rows.map((r: { id: string }, i: number) => ({
              id: r.id,
              vecteur: v[i],
            }))
          : [];
      })();
    }
    return this.vecteurs;
  }

  async proches(texte: string): Promise<{ id: string; score: number }[]> {
    const q = texte.trim().slice(0, 100);
    if (!this.actif() || q.length < 3 || !(await this.parametres.actif('recherche_semantique')))
      return [];
    try {
      const cat = await this.catalogue();
      if (cat.length === 0) return [];
      const v = await this.encoder([`query: ${q}`]);
      return v ? classerParSimilarite(v[0], cat) : [];
    } catch (e) {
      this.journal.warn(
        `Recherche sémantique en échec : ${(e as Error).message}`,
      );
      return [];
    }
  }
}
