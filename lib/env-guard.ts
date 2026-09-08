// Refusals for secrets that are missing, obviously placeholder, or too weak
// to be doing the job they are given.
//
// PIONEER_PASSWORD_SALT is the one that matters (finding S-8). It is the HMAC
// key that derives every Pioneer's Supabase password from their pi_uid
// (lib/supabase-admin.ts). Anyone holding it can compute any Pioneer's
// password and sign in as them without Pi ever being involved. It is not a
// nice-to-have setting, it is the whole authentication chain in one variable,
// and the two networks must not share one.
//
// A missing salt already threw. What did not was a salt someone set to
// "changeme" while getting a preview deployment working, or a short string
// that a search of the public repository's history would not find but a
// wordlist would.
//
// The check runs at first use rather than at module load: on Vercel a module
// level throw happens during the build, where the variable is not set and the
// failure means nothing. At first use it fails on the first sign in of a
// misconfigured deployment, loudly, with a message that says what to do.

/** Minimum length. 32 hex characters is what `openssl rand -hex 16` gives. */
export const MIN_SALT_LENGTH = 32

/**
 * Values that must never be a salt. Not an exhaustive list of weak strings,
 * which is not a thing that exists: it is the set of values that show up when
 * somebody is trying to make a deployment work and means to come back to it.
 */
const PLACEHOLDER_SALTS = new Set([
  "changeme",
  "change-me",
  "changethis",
  "default",
  "development",
  "dev",
  "example",
  "gyema",
  "insecure",
  "password",
  "placeholder",
  "replace-me",
  "replaceme",
  "salt",
  "secret",
  "test",
  "todo",
  "your-salt-here",
  "xxx",
])

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SecretConfigurationError"
  }
}

/**
 * Throw unless this value is fit to be the Pioneer password salt.
 *
 * Refuses: absent, blank, a known placeholder, shorter than MIN_SALT_LENGTH,
 * or built from fewer than eight distinct characters (which catches
 * "aaaaaaaa...", "12121212...", and the keyboard-mash that looks long and is
 * not).
 *
 * The value itself never appears in the message, in a log, or in a thrown
 * error. A refusal says what is wrong with it, never what it is.
 */
export function assertUsablePioneerSalt(value: string | undefined): asserts value is string {
  if (!value || value.trim() === "") {
    throw new SecretConfigurationError(
      "PIONEER_PASSWORD_SALT is not set. It is the HMAC key that derives every " +
        "Pioneer's Supabase password, so sign-in cannot proceed without it. " +
        "Generate one with `openssl rand -hex 32`, set it in this network's " +
        "Vercel environment, and redeploy. The two networks must not share one."
    )
  }

  const trimmed = value.trim()

  if (PLACEHOLDER_SALTS.has(trimmed.toLowerCase())) {
    throw new SecretConfigurationError(
      "PIONEER_PASSWORD_SALT is set to a placeholder value. Anyone who guesses " +
        "it can derive every Pioneer's password and sign in as them. Replace it " +
        "with `openssl rand -hex 32` and redeploy."
    )
  }

  if (trimmed.length < MIN_SALT_LENGTH) {
    throw new SecretConfigurationError(
      `PIONEER_PASSWORD_SALT is shorter than ${MIN_SALT_LENGTH} characters. ` +
        "It is the key to every Pioneer's account, not a namespace string. " +
        "Replace it with `openssl rand -hex 32` and redeploy."
    )
  }

  if (new Set(trimmed).size < 8) {
    throw new SecretConfigurationError(
      "PIONEER_PASSWORD_SALT is long but built from too few distinct characters " +
        "to be random. Replace it with `openssl rand -hex 32` and redeploy."
    )
  }
}
