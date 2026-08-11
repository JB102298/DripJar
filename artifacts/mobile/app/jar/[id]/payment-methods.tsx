/**
 * Route: /jar/[id]/payment-methods
 *
 * The screen itself lives in `components/payments/` as a platform-specific
 * pair, so Metro can resolve a web-safe version:
 *
 *   PaymentMethodsScreen.native.tsx — full Stripe PaymentSheet implementation
 *   PaymentMethodsScreen.web.tsx    — explains that payments are mobile-only
 *
 * The split cannot live on this route file. expo-router derives route names via
 * `removeSupportedExtensions`, which strips only `.js/.jsx/.ts/.tsx` — a
 * `payment-methods.web.tsx` here would register a literal route named
 * `payment-methods.web` rather than replacing this one. Keeping the route as a
 * thin re-export lets Metro's normal platform resolution do the work.
 */

export { default } from '@/components/payments/PaymentMethodsScreen';
