/** An error whose message is written for the plugin interface. */
export class UserFacingError extends Error {}

export function userErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EWOULDBLOCK") {
    return "Another operation is saving this paper. Try again shortly.";
  }
  return fallback;
}
