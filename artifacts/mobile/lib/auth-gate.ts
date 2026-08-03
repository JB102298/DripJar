// Route groups reachable while signed out (deep links from emails).
// Used by app/_layout.tsx's navigation guard; kept as a standalone module so
// it can be unit-tested without importing the Expo runtime.
export function isPublicRoute(firstSegment: string | undefined): boolean {
  return (
    firstSegment === "(auth)" ||
    firstSegment === "invite" || // Invitation links work while signed out
    firstSegment === "reset-password" // Password-reset email links work while signed out
  );
}
