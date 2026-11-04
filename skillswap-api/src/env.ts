// Charge le fichier .env s'il existe (Node 20.12+). Les variables déjà définies
// dans l'environnement restent prioritaires.
try {
  process.loadEnvFile();
} catch {
  // pas de .env : on garde l'environnement tel quel
}
