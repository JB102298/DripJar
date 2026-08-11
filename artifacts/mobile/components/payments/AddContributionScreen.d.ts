/**
 * Type declaration for the platform-specific AddContributionScreen pair.
 *
 * Metro resolves `AddContributionScreen.native.tsx` or `.web.tsx` by platform at
 * bundle time, but `tsc` does not apply React Native platform extensions, so it
 * cannot resolve the extensionless import in the route file. This declaration
 * describes the shared shape both implementations satisfy.
 *
 * Both implementations are still fully type-checked on their own — they are
 * matched by the tsconfig `**\/*.tsx` include. This file only types the edge
 * between the route and the component, which takes no props (route parameters
 * come from `useLocalSearchParams`).
 */

import type { ComponentType } from 'react';

declare const AddContributionScreen: ComponentType<Record<string, never>>;
export default AddContributionScreen;
