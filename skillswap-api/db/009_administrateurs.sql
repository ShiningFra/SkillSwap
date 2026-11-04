-- Comptes administrateur : mot de passe provisoire à changer à la première connexion.
ALTER TABLE utilisateur ADD COLUMN IF NOT EXISTS mdp_provisoire boolean NOT NULL DEFAULT false;
