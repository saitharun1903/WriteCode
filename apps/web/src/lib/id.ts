/** Random, URL-safe identifier. Uses the platform CSPRNG. */
export function createId(): string {
  return crypto.randomUUID();
}
