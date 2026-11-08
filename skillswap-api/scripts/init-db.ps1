# Crée la base skillswap et applique les scripts SQL (Windows PowerShell).
# Usage :  .\scripts\init-db.ps1 -MotDePasse "ton_mot_de_passe" [-Exemples]
param(
  [Parameter(Mandatory = $true)][string]$MotDePasse,
  [string]$Hote = "localhost",
  [int]$Port = 5432,
  [string]$Base = "skillswap",
  [switch]$Exemples,   # ajoute quelques compétences d'exemple (développement)
  [switch]$Reinitialiser  # supprime la base existante avant de la recréer
)
$ErrorActionPreference = "Stop"

# Retrouve psql.exe s'il n'est pas dans le PATH (installation par défaut de PostgreSQL).
$psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
if (-not $psql) {
  $psql = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $psql) { throw "psql.exe introuvable : installe PostgreSQL ou ajoute son dossier bin au PATH." }

$env:PGPASSWORD = $MotDePasse
# Les fichiers SQL sont en UTF-8 : sans cela, psql les lit en WIN1252 sous Windows et abîme les accents (« FranÃ§ais »).
$env:PGCLIENTENCODING = "UTF8"
$racine = Split-Path $PSScriptRoot -Parent
function Sql($base, [string[]]$args2) { & $psql -U postgres -h $Hote -p $Port -d $base -v ON_ERROR_STOP=1 -q @args2; if ($LASTEXITCODE -ne 0) { throw "psql a échoué" } }

if ($Reinitialiser) { Sql "postgres" @("-c", "DROP DATABASE IF EXISTS $Base WITH (FORCE);") }
$existe = & $psql -U postgres -h $Hote -p $Port -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$Base'"
if ($existe -eq "1") { throw "La base '$Base' existe déjà. Relance avec -Reinitialiser pour la recréer." }
# Base en UTF-8 quelle que soit la locale de Windows (PostgreSQL 15 ou plus ; sinon création simple).
$version = [int](& $psql -U postgres -h $Hote -p $Port -d postgres -tAc "SHOW server_version_num")
if ($version -ge 150000) {
  Sql "postgres" @("-c", "CREATE DATABASE $Base ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'fr-FR' LOCALE 'C' TEMPLATE template0;")
} else {
  Sql "postgres" @("-c", "CREATE DATABASE $Base ENCODING 'UTF8' TEMPLATE template0;")
}

$scripts = @("001_schema.sql", "002_seed.sql", "003_securite.sql", "005_moderation.sql", "006_moderation_charge.sql", "007_suppression_compte.sql", "008_reinitialisation_mdp.sql", "009_administrateurs.sql", "010_notification_lien.sql", "011_push.sql", "012_notification_lien_anciennes.sql", "013_competences_catalogue.sql", "014_parametres.sql", "015_notification_signalement.sql", "016_portefeuille.sql")
if ($Exemples) { $scripts += "004_dev_competences.sql" }
foreach ($s in $scripts) {
  Write-Host "Application de $s"
  Sql $Base @("-f", (Join-Path $racine "db\$s"))
}
Write-Host ""
Write-Host "Base '$Base' prête. Chaîne de connexion à mettre dans .env :"
Write-Host "DATABASE_URL=postgres://postgres:$MotDePasse@${Hote}:$Port/$Base"
