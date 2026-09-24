/**
 * The one surface a database adapter uses (PT-3, D174a): `pg`'s pool in
 * production, an in-process PGlite in tests. Adapters take a `SqlClient`, never
 * a driver, so the store code is the same against both.
 */

/** The rows a statement returned. */
export interface SqlRows<R> {
  readonly rows: R[];
}

/** Statements, with or without a transaction around them. */
export interface SqlQuery {
  /** One statement, parameterised (`$1`, `$2`, …). */
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlRows<R>>;
  /** A script of one or more statements, unparameterised (a migration). */
  exec(text: string): Promise<void>;
}

export interface SqlClient extends SqlQuery {
  /** Run `work` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(work: (tx: SqlQuery) => Promise<T>): Promise<T>;
  /** Close every connection. */
  end(): Promise<void>;
}
