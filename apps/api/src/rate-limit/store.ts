import { pool } from "../db/pool.js";
import type { RateLimitPolicy } from "./policy.js";

export type RateLimitVerdict = {
  allowed: boolean;
  /** How many requests have landed in the current window, including this one. */
  count: number;
  /** Seconds until the window resets. Sent as `Retry-After` on a refusal. */
  retryAfterSeconds: number;
};

/**
 * Counts one request against a window, and says whether it is allowed.
 *
 * The whole thing is **one statement** on purpose. A read-then-write would
 * race: two requests arriving together would both read a count under the
 * limit and both write limit+1, which is precisely the concurrency a
 * flood produces, so a limiter with that race is weakest exactly when it
 * matters. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` takes a row
 * lock and returns the post-increment value, so N concurrent requests get
 * N distinct counts with no transaction management here.
 *
 * The window is reset inside the same statement rather than by a separate
 * expiry pass: if the stored window has aged out, this request becomes
 * count 1 of a new window. That is why nothing needs to delete rows on
 * time for the limiter to be correct — `pruneExpiredCounters` below is
 * about table size, not correctness.
 *
 * An over-limit request still increments the count but does **not** move
 * `window_start`, so hammering a limit cannot extend the block. The
 * window always ends when it was always going to end.
 */
export async function countRequest(policy: RateLimitPolicy, subject: string): Promise<RateLimitVerdict> {
  const { rows } = await pool.query<{ count: number; retry_after_seconds: number }>(
    `INSERT INTO rate_limit_counters (bucket, subject, window_start, count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (bucket, subject) DO UPDATE SET
       count = CASE
         WHEN rate_limit_counters.window_start <= now() - make_interval(secs => $3::double precision)
         THEN 1
         ELSE rate_limit_counters.count + 1
       END,
       window_start = CASE
         WHEN rate_limit_counters.window_start <= now() - make_interval(secs => $3::double precision)
         THEN now()
         ELSE rate_limit_counters.window_start
       END
     RETURNING
       count,
       CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $3::double precision)) - now()))::int
         AS retry_after_seconds`,
    [policy.bucket, subject, policy.windowSeconds],
  );

  const row = rows[0];
  return {
    allowed: row.count <= policy.limit,
    count: Number(row.count),
    // Never advertise 0 seconds: a client that respects Retry-After
    // literally would retry immediately into the same refusal.
    retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds)),
  };
}

/**
 * Deletes counters whose window ended long ago.
 *
 * Rows are bounded by the number of distinct (bucket, subject) pairs and
 * are reused, so this is housekeeping rather than a correctness
 * requirement — but "distinct subject" includes every IP that ever
 * touched the API, and Receiptless's review raised unbounded table growth
 * (its `Session` table) as a real finding, so the same mistake is not
 * being made in a table this one introduces.
 */
export async function pruneExpiredCounters(olderThanSeconds = 24 * 60 * 60): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM rate_limit_counters
     WHERE window_start < now() - make_interval(secs => $1::double precision)`,
    [olderThanSeconds],
  );
  return rowCount ?? 0;
}
