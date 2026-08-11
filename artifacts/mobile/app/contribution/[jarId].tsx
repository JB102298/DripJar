/**
 * Route: /contribution/[jarId]
 *
 * The screen itself lives in `components/payments/` as a platform-specific
 * pair, so Metro can resolve a web-safe version:
 *
 *   AddContributionScreen.native.tsx — full Stripe PaymentSheet implementation
 *   AddContributionScreen.web.tsx    — explains that contributions are mobile-only
 *
 * The split cannot live on this route file. expo-router derives route names via
 * `removeSupportedExtensions`, which strips only `.js/.jsx/.ts/.tsx` — a
 * `[jarId].web.tsx` here would register a literal route named `[jarId].web`
 * rather than replacing this one. Keeping the route as a thin re-export lets
 * Metro's normal platform resolution do the work.
 */

export { default } from '@/components/payments/AddContributionScreen';
