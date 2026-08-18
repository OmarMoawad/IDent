import Link from "next/link";
import styles from "./onboarding.module.css";

/**
 * Session 22c: the first page anyone sees said "Phase 0B — Identity Core"
 * and pointed at a file in the repository. External review finding #8
 * called the onboarding pages unfinished; this one was also addressed to
 * the wrong reader — someone arriving at IDent is not looking for a
 * status note about a phase number.
 *
 * What it says now is what is actually true of the product today, and no
 * more than that: the identity core and a unified inbox exist, and it is
 * not hosted anywhere. Overselling here would contradict SECURITY.md's
 * own standing rule about claims.
 */
export default function HomePage() {
  return (
    <main className={styles.shell}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>IDent</p>
        <h1>One account for the things that are yours</h1>
        <p className={styles.lede}>
          A username and a password you choose — no phone number — with your messages, calendar, contacts and
          notifications in one place, and a read-only assistant that can answer questions about them.
        </p>

        <div className={styles.actions}>
          <Link href="/register">
            <button type="button">Create an account</button>
          </Link>
          <Link href="/login">
            <button type="button" className={styles.secondary}>
              Log in
            </button>
          </Link>
        </div>

        <hr className={styles.divider} />

        <p className={styles.footerNote}>
          This is an early build, running locally rather than hosted. What is and is not finished is written
          down in <code>IDent_STATE.md</code> and <code>ROADMAP.md</code> in the repository, including the
          parts that are deliberately not built yet.
        </p>
      </div>
    </main>
  );
}
