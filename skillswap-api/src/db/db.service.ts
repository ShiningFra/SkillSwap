import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
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

  onModuleDestroy() {
    return this.pool.end();
  }
}
