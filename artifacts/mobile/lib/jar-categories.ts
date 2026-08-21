/**
 * Centralised jar category model.
 *
 * WHY THIS FILE EXISTS
 *
 * DripJar started as a group-travel product and the create flow still spoke
 * that way everywhere: "When is the trip?", "Trip Start Date", "What makes this
 * trip special?", "Ready for takeoff!", "Milestones help track specific
 * expenses like flights or lodging". Seventeen such strings across seven files.
 * That copy is correct for a cruise and nonsense for an emergency fund, and the
 * category list has just grown from eight values to fifteen — including
 * `EmergencyFund`, `Education`, and `HomeDownPayment`, which involve no trip at
 * all.
 *
 * The obvious fix — `category === 'Vacation' ? … : …` at each of the seventeen
 * sites — produces seventeen places to update every time a category is added,
 * and no way to see at a glance what any single category actually says. So
 * every piece of category-varying copy lives here instead, one record per
 * category, and the screens read fields off that record.
 *
 * `Other` IS THE FALLBACK, NOT JUST A CHOICE
 *
 * `jars.category` is free text on the server — `routes/jars.ts` writes whatever
 * the client sent, with no enum validation, and the column predates the current
 * list. Rows therefore exist with values this build has never heard of, and
 * more will appear whenever an older client writes one. `resolveCategory`
 * always returns a config, falling back to `Other`, whose copy is deliberately
 * neutral enough to be correct for anything. A screen can never crash or render
 * a blank heading because of an unrecognised category.
 */
import type { ComponentProps } from 'react';
import type { Feather } from '@expo/vector-icons';
import type { DatePrecision } from './date-precision';

type FeatherIconName = ComponentProps<typeof Feather>['name'];

/** The fifteen catalogued categories. Mirrors the enum in lib/api-spec/openapi.yaml. */
export type JarCategoryId =
  | 'Vacation'
  | 'Cruise'
  | 'MissionTrip'
  | 'Wedding'
  | 'Honeymoon'
  | 'Reunion'
  | 'Celebration'
  | 'HomeDownPayment'
  | 'Vehicle'
  | 'LargePurchase'
  | 'Education'
  | 'EmergencyFund'
  | 'BusinessProject'
  | 'FamilyGoal'
  | 'Other';

/** Grouping used only to section the category picker. */
export type CategoryGroup = 'travel' | 'lifeEvent' | 'majorPurchase' | 'financial' | 'other';

export const CATEGORY_GROUP_LABELS: Record<CategoryGroup, string> = {
  travel: 'Travel',
  lifeEvent: 'Life events',
  majorPurchase: 'Major purchases',
  financial: 'Financial goals',
  other: 'Something else',
};

/** Order the picker renders groups in. */
export const CATEGORY_GROUP_ORDER: readonly CategoryGroup[] = [
  'travel',
  'lifeEvent',
  'majorPurchase',
  'financial',
  'other',
] as const;

/**
 * The optional free-text place field (step 1) and its review-screen label.
 *
 * `null` for categories where a place is meaningless. An emergency fund has no
 * destination, and prompting for one invites junk data into a column that
 * several screens render unconditionally.
 */
export interface CategoryLocationField {
  label: string;
  placeholder: string;
  /** Row label on the review screen. Usually the same word without "(Optional)". */
  reviewLabel: string;
}

/**
 * The optional event window (step 2) — the dates of the thing being saved for,
 * as distinct from the savings target date.
 *
 * `null` for categories with no event: an emergency fund is never "on" a date.
 * Those categories collect only a savings target date.
 */
export interface CategoryEventWindow {
  startLabel: string;
  startPlaceholder: string;
  endLabel: string;
  endPlaceholder: string;
  /** Shown when the savings target is later than the event start. */
  targetAfterStartError: string;
}

export interface CategoryConfig {
  id: JarCategoryId;
  /** Picker label. */
  label: string;
  icon: FeatherIconName;
  group: CategoryGroup;

  // ─── Step 1: name / category / place / description ───────────────────────
  /** Placeholder for the jar name field. */
  namePlaceholder: string;
  /** Placeholder for the free-text description field. */
  descriptionPlaceholder: string;
  locationField: CategoryLocationField | null;

  // ─── Step 2: dates ────────────────────────────────────────────────────────
  /** Step 2 heading — the date question this category actually asks. */
  dateHeading: string;
  eventWindow: CategoryEventWindow | null;
  /** Label for the savings target date. */
  targetDateLabel: string;
  /** Help text under the savings target date. */
  targetDateHelp: string;
  /**
   * Precision the target-date picker opens at.
   *
   * Long-horizon goals default to coarse: a college fund eighteen years out has
   * no known day, and offering one implies a certainty the organizer does not
   * have. The organizer can always switch to a finer precision.
   */
  defaultTargetPrecision: DatePrecision;
  /** Precision the event-window pickers open at. Ignored when `eventWindow` is null. */
  defaultEventPrecision: DatePrecision;

  // ─── Step 4: milestones ───────────────────────────────────────────────────
  milestoneHelp: string;
  /** Quick-add chips. First is used as the "e.g." placeholder in the add dialog. */
  milestoneSuggestions: readonly string[];

  // ─── Step 7: rules ────────────────────────────────────────────────────────
  /** Sub-heading above the agreement summary. */
  rulesHelper: string;

  // ─── Step 8: review ───────────────────────────────────────────────────────
  reviewTitle: string;
  reviewSubtitle: string;
}

/** Event window used by every category that has literal travel dates. */
function tripWindow(noun: string): CategoryEventWindow {
  return {
    startLabel: `${noun} Start Date (Optional)`,
    startPlaceholder: `Select ${noun.toLowerCase()} start date`,
    endLabel: `${noun} End Date (Optional)`,
    endPlaceholder: `Select ${noun.toLowerCase()} end date`,
    targetAfterStartError: `Target date must be before the ${noun.toLowerCase()} start date.`,
  };
}

/** Event window for a single-day event that may still span a weekend. */
function eventWindow(noun: string): CategoryEventWindow {
  return {
    startLabel: `${noun} Date (Optional)`,
    startPlaceholder: `Select the ${noun.toLowerCase()} date`,
    endLabel: `${noun} End Date (Optional)`,
    endPlaceholder: `Select the ${noun.toLowerCase()} end date`,
    targetAfterStartError: `Target date must be before the ${noun.toLowerCase()} date.`,
  };
}

const SAVE_BY_HELP_EVENT =
  'When do you want to have all the money saved by? We recommend 30–60 days before the date, so there is room for deposits and surprises.';
const SAVE_BY_HELP_PURCHASE =
  'When do you want to have all the money saved by? Everything the group contributes is working toward this date.';

/**
 * The catalogue.
 *
 * Declared as an ordered array rather than a map so the picker order is defined
 * here and not re-derived (and re-argued about) at each call site.
 */
export const CATEGORY_CONFIGS: readonly CategoryConfig[] = [
  {
    id: 'Vacation',
    label: 'Vacation',
    icon: 'sun',
    group: 'travel',
    namePlaceholder: 'e.g., Hawaii 2027',
    descriptionPlaceholder: 'What makes this trip special?',
    locationField: { label: 'Destination (Optional)', placeholder: 'e.g., Maui, Hawaii', reviewLabel: 'Destination' },
    dateHeading: 'When is the trip?',
    eventWindow: tripWindow('Trip'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_EVENT,
    defaultTargetPrecision: 'exact',
    defaultEventPrecision: 'exact',
    milestoneHelp: 'Milestones help track specific expenses like flights or lodging.',
    milestoneSuggestions: ['Flights', 'Lodging', 'Activities', 'Food', 'Emergency Buffer'],
    rulesHelper: 'Clear expectations make group trips stress-free. Review the standard agreement below.',
    reviewTitle: 'Ready for takeoff!',
    reviewSubtitle: 'Review your trip details before we create your jar.',
  },
  {
    id: 'Cruise',
    label: 'Cruise',
    icon: 'anchor',
    group: 'travel',
    namePlaceholder: 'e.g., Caribbean Cruise 2027',
    descriptionPlaceholder: 'What makes this cruise special?',
    locationField: { label: 'Itinerary or Ship (Optional)', placeholder: 'e.g., Eastern Caribbean', reviewLabel: 'Itinerary' },
    dateHeading: 'When do you sail?',
    eventWindow: tripWindow('Cruise'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp:
      'When do you want to have all the money saved by? Cruise lines usually want the balance well before sailing.',
    defaultTargetPrecision: 'exact',
    defaultEventPrecision: 'exact',
    milestoneHelp: 'Milestones help track specific expenses like the cabin deposit or excursions.',
    milestoneSuggestions: ['Cabin Deposit', 'Final Balance', 'Excursions', 'Flights to Port', 'Onboard Spending'],
    rulesHelper: 'Clear expectations make group travel stress-free. Review the standard agreement below.',
    reviewTitle: 'Ready to set sail!',
    reviewSubtitle: 'Review your cruise details before we create your jar.',
  },
  {
    id: 'MissionTrip',
    label: 'Mission Trip',
    icon: 'globe',
    group: 'travel',
    namePlaceholder: 'e.g., Guatemala Mission 2027',
    descriptionPlaceholder: 'What is the purpose of this trip?',
    locationField: { label: 'Destination (Optional)', placeholder: 'e.g., Antigua, Guatemala', reviewLabel: 'Destination' },
    dateHeading: 'When is the trip?',
    eventWindow: tripWindow('Trip'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp:
      'When do you want to have all the money saved by? Sending organisations often set their own deadline — use theirs if it is earlier.',
    defaultTargetPrecision: 'exact',
    defaultEventPrecision: 'exact',
    milestoneHelp: 'Milestones help track specific costs like travel, lodging, and supplies.',
    milestoneSuggestions: ['Airfare', 'Lodging', 'Supplies', 'Program Fees', 'Vaccinations'],
    rulesHelper: 'Clear expectations keep the team aligned. Review the standard agreement below.',
    reviewTitle: 'Ready to go!',
    reviewSubtitle: 'Review your trip details before we create your jar.',
  },

  {
    id: 'Wedding',
    label: 'Wedding',
    icon: 'heart',
    group: 'lifeEvent',
    namePlaceholder: 'e.g., Alex & Sam’s Wedding',
    descriptionPlaceholder: 'What are you planning?',
    locationField: { label: 'Venue or Location (Optional)', placeholder: 'e.g., Asheville, NC', reviewLabel: 'Venue' },
    dateHeading: 'When is the wedding?',
    eventWindow: eventWindow('Wedding'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp:
      'When do you want to have all the money saved by? Most vendors want final payment before the day itself.',
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track specific costs like the venue, catering, and photography.',
    milestoneSuggestions: ['Venue', 'Catering', 'Photography', 'Attire', 'Flowers'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to celebrate!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'Honeymoon',
    label: 'Honeymoon',
    icon: 'map',
    group: 'lifeEvent',
    namePlaceholder: 'e.g., Honeymoon in Italy',
    descriptionPlaceholder: 'What makes this trip special?',
    locationField: { label: 'Destination (Optional)', placeholder: 'e.g., Amalfi Coast, Italy', reviewLabel: 'Destination' },
    dateHeading: 'When is the honeymoon?',
    eventWindow: tripWindow('Trip'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_EVENT,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track specific expenses like flights or lodging.',
    milestoneSuggestions: ['Flights', 'Hotel', 'Excursions', 'Dining', 'Spending Money'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready for takeoff!',
    reviewSubtitle: 'Review your trip details before we create your jar.',
  },
  {
    id: 'Reunion',
    label: 'Reunion',
    icon: 'users',
    group: 'lifeEvent',
    namePlaceholder: 'e.g., Family Reunion 2027',
    descriptionPlaceholder: 'Who is getting together, and why?',
    locationField: { label: 'Location (Optional)', placeholder: 'e.g., Lake Norman, NC', reviewLabel: 'Location' },
    dateHeading: 'When is the reunion?',
    eventWindow: eventWindow('Reunion'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_EVENT,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track specific costs like the venue, food, and lodging.',
    milestoneSuggestions: ['Venue', 'Food', 'Lodging', 'Travel', 'Activities'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to bring everyone together!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'Celebration',
    label: 'Celebration',
    icon: 'award',
    group: 'lifeEvent',
    namePlaceholder: 'e.g., Mom’s 60th Birthday',
    descriptionPlaceholder: 'What are you celebrating?',
    locationField: { label: 'Location (Optional)', placeholder: 'e.g., Charlotte, NC', reviewLabel: 'Location' },
    dateHeading: 'When is the celebration?',
    eventWindow: eventWindow('Celebration'),
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_EVENT,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track specific costs like the venue, food, and gifts.',
    milestoneSuggestions: ['Venue', 'Food', 'Decorations', 'Gift', 'Entertainment'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to celebrate!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },

  {
    id: 'HomeDownPayment',
    label: 'Home Down Payment',
    icon: 'home',
    group: 'majorPurchase',
    namePlaceholder: 'e.g., Our First Home',
    descriptionPlaceholder: 'What are you saving toward?',
    locationField: { label: 'Area (Optional)', placeholder: 'e.g., Raleigh, NC', reviewLabel: 'Area' },
    dateHeading: 'When do you want to be ready?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_PURCHASE,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track the pieces of the purchase separately.',
    milestoneSuggestions: ['Down Payment', 'Closing Costs', 'Inspection', 'Moving Costs', 'Reserve Fund'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'Vehicle',
    label: 'Vehicle',
    icon: 'truck',
    group: 'majorPurchase',
    namePlaceholder: 'e.g., Family Van Fund',
    descriptionPlaceholder: 'What are you saving toward?',
    locationField: null,
    dateHeading: 'When do you want to be ready?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_PURCHASE,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track the pieces of the purchase separately.',
    milestoneSuggestions: ['Down Payment', 'Taxes & Fees', 'Insurance', 'Maintenance Reserve'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'LargePurchase',
    label: 'Large Purchase',
    icon: 'shopping-bag',
    group: 'majorPurchase',
    namePlaceholder: 'e.g., New Kitchen',
    descriptionPlaceholder: 'What are you saving toward?',
    locationField: null,
    dateHeading: 'When do you want to be ready?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_PURCHASE,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track the pieces of the purchase separately.',
    milestoneSuggestions: ['Deposit', 'Balance', 'Delivery', 'Installation', 'Reserve Fund'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },

  {
    id: 'Education',
    label: 'Education',
    icon: 'book-open',
    group: 'financial',
    namePlaceholder: 'e.g., Ava’s College Fund',
    descriptionPlaceholder: 'What are you saving toward?',
    locationField: { label: 'School (Optional)', placeholder: 'e.g., State University', reviewLabel: 'School' },
    dateHeading: 'When will the money be needed?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp:
      'When do you want to have all the money saved by? For a newborn’s college fund this is often eighteen years out — pick the year and refine it later.',
    // A newborn's college fund has a known year and no known month or day.
    defaultTargetPrecision: 'year',
    defaultEventPrecision: 'year',
    milestoneHelp: 'Milestones help split the goal into the pieces it will actually be spent on.',
    milestoneSuggestions: ['Tuition', 'Housing', 'Books & Supplies', 'Travel', 'Reserve Fund'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'EmergencyFund',
    label: 'Emergency Fund',
    icon: 'shield',
    group: 'financial',
    namePlaceholder: 'e.g., Household Emergency Fund',
    descriptionPlaceholder: 'What is this fund for?',
    locationField: null,
    dateHeading: 'When do you want to be fully funded?',
    eventWindow: null,
    targetDateLabel: 'Fully Funded By',
    targetDateHelp:
      'When do you want the fund to be complete? There is no event here — this date just sets the pace.',
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help build the fund in stages rather than all at once.',
    milestoneSuggestions: ['First $1,000', 'One Month of Expenses', 'Three Months', 'Six Months'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'BusinessProject',
    label: 'Business Project',
    icon: 'briefcase',
    group: 'financial',
    namePlaceholder: 'e.g., Storefront Buildout',
    descriptionPlaceholder: 'What are you funding?',
    locationField: { label: 'Location (Optional)', placeholder: 'e.g., Durham, NC', reviewLabel: 'Location' },
    dateHeading: 'When does the project need to be funded?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_PURCHASE,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help track the phases of the project separately.',
    milestoneSuggestions: ['Equipment', 'Deposit', 'Licensing', 'Marketing', 'Working Capital'],
    rulesHelper: 'Clear expectations keep every contributor aligned. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
  {
    id: 'FamilyGoal',
    label: 'Family Goal',
    icon: 'smile',
    group: 'financial',
    namePlaceholder: 'e.g., Family Savings Goal',
    descriptionPlaceholder: 'What is the family saving for?',
    locationField: null,
    dateHeading: 'When do you want to reach the goal?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_PURCHASE,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help split the goal into smaller pieces.',
    milestoneSuggestions: ['First Milestone', 'Halfway', 'Final Stretch', 'Reserve Fund'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },

  {
    id: 'Other',
    label: 'Other',
    icon: 'star',
    group: 'other',
    // Deliberately generic in every field: this record is also what an
    // unrecognised stored value resolves to, so it has to read correctly for a
    // goal nobody anticipated.
    namePlaceholder: 'e.g., Our Savings Goal',
    descriptionPlaceholder: 'What are you saving for?',
    locationField: { label: 'Location (Optional)', placeholder: 'e.g., Charlotte, NC', reviewLabel: 'Location' },
    dateHeading: 'When do you need the money?',
    eventWindow: null,
    targetDateLabel: 'Savings Target Date',
    targetDateHelp: SAVE_BY_HELP_PURCHASE,
    defaultTargetPrecision: 'monthYear',
    defaultEventPrecision: 'monthYear',
    milestoneHelp: 'Milestones help split the goal into smaller pieces you can track separately.',
    milestoneSuggestions: ['First Milestone', 'Halfway', 'Final Stretch', 'Reserve Fund'],
    rulesHelper: 'Clear expectations keep everyone comfortable contributing. Review the standard agreement below.',
    reviewTitle: 'Ready to start saving!',
    reviewSubtitle: 'Review the details before we create your jar.',
  },
] as const;

/** The fallback config, exported so callers can compare identity if they need to. */
export const OTHER_CATEGORY: CategoryConfig =
  CATEGORY_CONFIGS.find((c) => c.id === 'Other')!;

const CONFIG_BY_ID = new Map<string, CategoryConfig>(
  CATEGORY_CONFIGS.map((c) => [c.id, c]),
);

/**
 * Resolve any stored category value to a config. NEVER returns undefined.
 *
 * `jars.category` is nullable free text written without server-side validation,
 * so this receives `null`, legacy ids, and values from newer clients. All of
 * them resolve to `Other` rather than leaving a screen with no copy to render.
 */
export function resolveCategory(value: string | null | undefined): CategoryConfig {
  if (!value) return OTHER_CATEGORY;
  return CONFIG_BY_ID.get(value) ?? OTHER_CATEGORY;
}

/** True when `value` is one of the fifteen catalogued ids. */
export function isKnownCategory(value: string | null | undefined): value is JarCategoryId {
  return !!value && CONFIG_BY_ID.has(value);
}

/** Display label for a stored value, falling back to "Other". */
export function categoryLabel(value: string | null | undefined): string {
  return resolveCategory(value).label;
}

/** Categories in a group, in catalogue order. */
export function categoriesInGroup(group: CategoryGroup): CategoryConfig[] {
  return CATEGORY_CONFIGS.filter((c) => c.group === group);
}
