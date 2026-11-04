# SkillSwap API (NestJS, PostgreSQL)

Premier lot du backend : socle de sécurité (CDC 7.6, ES1 à ES13), comptes, téléphone par SMS, localisation et compétences.

## Démarrer (Windows : voir plus bas)

```bash
createdb skillswap
psql skillswap -f db/001_schema.sql -f db/002_seed.sql -f db/003_securite.sql -f db/005_moderation.sql -f db/006_moderation_charge.sql -f db/007_suppression_compte.sql
cp .env.example .env            # puis adapter
npm run start:dev                # http://localhost:3001
```

## Routes

| Méthode et route | Accès | Rôle |
|---|---|---|
| `POST /auth/inscription` | public, 10/min/IP | crée le compte, ouvre la session (cookie) |
| `POST /auth/connexion` | public, 20/min/IP, 5 échecs/15 min/compte | ouvre la session |
| `POST /auth/deconnexion` | public | révoque la session |
| `GET /moi` | session | profil sans e-mail, téléphone ni coordonnées |
| `POST /telephone/code` | session, 3 envois/h | envoie un code SMS (RG17) |
| `POST /telephone/verifier` | session | valide le code (5 essais, 10 min) |
| `PUT /moi/localisation` | session | AUCUNE, MANUELLE ou AUTOMATIQUE avec consentement (RG5) |
| `GET /competences` | public | catalogue |
| `GET /moi/competences`, `POST /moi/competences`, `DELETE /moi/competences/:id` | session | déclarations du membre (RG3, RG18) |
| `GET /profils?competenceId=…` | session, 20/min | recherche ; distance par paliers, jamais de coordonnées (ES8) |
| `GET /profils/:id` | session, 30/min | profil public, avis récents, créneaux libres |
| `GET /moi/creneaux`, `POST /moi/creneaux` | session | créneaux du membre (RG6) |
| `POST /conversations`, `GET /conversations`, `GET /conversations/:id` | session | fil unique par couple (RG2), téléphone vérifié (RG17) ; lecture réservée aux deux membres |
| `POST /conversations/:id/messages` | session, 30/min | envoie un message, notifie le destinataire |
| `POST /conversations/:id/sessions` | session | propose une session sur un créneau de l'autre membre (RG9, RG16, RG20) |
| `GET /sessions`, `GET /sessions/:id` | session | sessions du membre ; les propositions sans réponse après 72 h expirent (RG10) |
| `POST /sessions/:id/reponse` / `confirmation` / `absence` | session | accepter ou refuser ; confirmer (RG11) ; déclarer une absence (RG19 : avertissement, suspension à 3 en 90 jours) |
| `POST /sessions/:id/avis` | session | un avis par auteur sur une session réalisée |
| `POST /signalements` | session | 5 par heure au plus, un seul signalement ouvert par cible (RG13) |

Les erreurs renvoient `{ "cle": "errors.xxx", "champs": { ... } }` : ce sont les clés de traduction du frontend.

## Sécurité

Vérifications automatisées dans `test/securite.e2e-spec.ts` (27 tests contre un vrai PostgreSQL) :
ES2 argon2id, ES3 connexion, ES4 session et CSRF, ES5 code SMS, ES6 contrôle d'accès, ES7 entrées hostiles,
ES8 localisation, ES10 audit, ES11 en-têtes et CORS, ES13 limitation de débit.

```bash
npm run test:e2e      # recrée la base skillswap_api_test (TEST_ADMIN_URL, TEST_DATABASE_URL)
```

Les règles métier des échanges sont vérifiées dans `test/echanges.e2e-spec.ts` (15 tests : accès entre membres, RG2, RG9, RG10, RG11, RG16, RG17, RG19, RG20, ES8, plafonds de signalement).

## Pas encore fait

Lecture des notifications et espace administrateur (traitement des signalements) ;
prestataire SMS réel (`SmsPort` à implémenter) ; ES9 chiffrement des sauvegardes et ES14 à ES16 (exploitation) ;
ES12 audit des dépendances en CI.

## Dépendances (ES12)

`npm audit --omit=dev` signale `multer` (déni de service lié à `fileFilter`, via `@nestjs/platform-express`). Aucun correctif n'est publié à ce jour et l'API n'accepte aucun envoi de fichier : la faille n'est pas atteignable. À recontrôler avant chaque mise en production.

## Base de données sous Windows

1. Installe PostgreSQL 16 (postgresql.org/download/windows), garde le port 5432 et note le mot de passe de `postgres`.
2. Dans PowerShell, depuis le dossier `skillswap-api` :
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\scripts\init-db.ps1 -MotDePasse "ton_mot_de_passe" -Exemples
   ```
   Le script crée la base, applique `db/001` à `db/003` (et `004` avec `-Exemples`) et affiche la ligne `DATABASE_URL` à copier dans `.env`. `-Reinitialiser` supprime et recrée la base.
3. `npm install`, puis `npm run start:dev`.

Si les accents apparaissent abîmés (« FranÃ§ais ») dans `/competences`, la base a été remplie avec un mauvais encodage : relance `.\scripts\init-db.ps1 -MotDePasse "..." -Exemples -Reinitialiser` (version corrigée du script).

## Administration (v0.5)

Routes réservées au rôle `ADMIN` (403 sinon) : `GET /admin/indicateurs`, `GET /admin/signalements`, `GET /admin/signalements/:id`, `POST /admin/signalements/:id/decision` (`AVERTIR`, `SUSPENDRE`, `REJETER`, commentaire facultatif). Chaque décision est tracée dans `journal_audit`.

Pour une base existante, applique `db/005_moderation.sql` puis `db/006_moderation_charge.sql` (gravité, retrait du motif « absence sans prévenir ») (nouveau type de notification `AVERTISSEMENT`). Pour te donner le rôle :

```sql
UPDATE utilisateur SET role = 'ADMIN' WHERE email = 'ton@email';
```

## Compte (v0.6)

`POST /moi/suppression` avec `{ "motDePasse": "..." }` : suppression par anonymisation (RG14), 204. Appliquer `db/007_suppression_compte.sql` sur une base existante (statut `SUPPRIME`). La recherche (`GET /profils`) renvoie maintenant `offres` (toutes les offres correspondantes) et `reciproques`.
