import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Client, Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

@Injectable()
export class Db implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: config().databaseUrl,
    max: 10,
  });

  /** Requêtes toujours paramétrées (ES7) : les valeurs ne sont jamais concaténées au texte SQL. */
  query<T extends QueryResultRow = QueryResultRow>(
    texte: string,
    valeurs: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(texte, valeurs);
  }

  async transaction<T>(
    travail: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const resultat = await travail(client);
      await client.query('COMMIT');
      return resultat;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private ecouteur?: Client;
  private arrete = false;

  /** Écoute un canal LISTEN/NOTIFY sur une connexion dédiée, rétablie automatiquement en cas de coupure. */
  async ecouter(canal: string, rappel: (charge: string) => void) {
    const ouvrir = async () => {
      if (this.arrete) return;
      const client = new Client({ connectionString: config().databaseUrl });
      client.on('notification', (m) => rappel(m.payload ?? ''));
      client.on('error', () => {
        void client.end().catch(() => undefined);
        if (!this.arrete)
          setTimeout(() => void ouvrir().catch(() => undefined), 5000);
      });
      await client.connect();
      await client.query(`LISTEN ${canal}`);
      this.ecouteur = client;
    };
    await ouvrir();
  }

  async onModuleDestroy() {
    this.arrete = true;
    await this.ecouteur?.end().catch(() => undefined);
    await this.pool.end();
  }
}
