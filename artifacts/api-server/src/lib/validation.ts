import { z } from "zod";

// ─── Shared primitives ────────────────────────────────────────────────────────

const email = z
  .string({ required_error: "Email is required" })
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Email must be a valid email address")
  .max(254, "Email must be at most 254 characters");

const password = z
  .string({ required_error: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters");

const nonEmptyName = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(100, `${label} must be at most 100 characters`)
    .refine((v) => v.trim().length > 0, `${label} must not be whitespace only`);

// ─── Auth schemas ─────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email,
  password,
  firstName: nonEmptyName("First name"),
  lastName: nonEmptyName("Last name"),
}).strict();

export const loginSchema = z.object({
  email,
  password: z.string({ required_error: "Password is required" }).min(1, "Password is required"),
}).strict();

export const forgotPasswordSchema = z.object({
  email,
}).strict();

export const resetPasswordSchema = z.object({
  token: z.string({ required_error: "Reset token is required" }).min(1, "Reset token is required"),
  password,
}).strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string({ required_error: "Current password is required" }).min(1, "Current password is required"),
  newPassword: password,
}).strict();

export const verifyEmailSchema = z.object({
  token: z.string({ required_error: "Verification token is required" }).min(1, "Verification token is required"),
}).strict();

export const refreshTokenSchema = z.object({
  refreshToken: z.string({ required_error: "Refresh token is required" }).min(1, "Refresh token is required"),
}).strict();

// ─── Profile schema ───────────────────────────────────────────────────────────

export const profileUpdateSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Display name must not be empty")
    .max(100, "Display name must be at most 100 characters")
    .refine((v) => v.trim().length > 0, "Display name must not be whitespace only")
    .optional(),
  firstName: nonEmptyName("First name").optional(),
  lastName: nonEmptyName("Last name").optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  timeZone: z.string().trim().max(100).optional(),
  avatarUrl: z.string().url("Avatar URL must be a valid URL").nullable().optional(),
}).strict();

// ─── Contribution schedule schemas ────────────────────────────────────────────

/**
 * Frequencies the schedule engine understands.
 *
 * `weekly` / `biweekly` / `monthly` / `twiceMonthly` are the recurring cadences
 * resolved by `computeNextDueDate`. `manual` is a recognized non-recurring mode
 * — `countElapsedPeriods` special-cases it and returns 0 elapsed periods.
 *
 * Any other string previously produced a schedule that silently never fired,
 * because `computeNextDueDate` returns null for unrecognized frequencies.
 */
export const SCHEDULE_FREQUENCIES = [
  "weekly",
  "biweekly",
  "monthly",
  "twiceMonthly",
  "manual",
] as const;

/**
 * Upper bound for a single scheduled contribution: $1,000,000.
 * `contribution_schedules.amount_cents` is a PostgreSQL `integer`, so values
 * above 2,147,483,647 would fail at the driver. This bound sits well below
 * that and is far above any realistic group-savings contribution.
 */
export const MAX_SCHEDULE_AMOUNT_CENTS = 100_000_000;

/**
 * `preferredDay` is constrained to 1–28 rather than 1–31, for two reasons:
 *
 *   1. `advanceTwiceMonthly` derives the second occurrence as
 *      `min(preferredDay + 15, 28)`. A `preferredDay` above 28 makes the second
 *      day land *before* the first, inverting the ordering that both
 *      `computeNextDueDate` and `computePreviousDueDate` depend on.
 *   2. Days 29–31 do not exist in every month, so they are silently clamped —
 *      producing a schedule whose real cadence differs from what was requested.
 *
 * 28 is the largest day present in all months, so it is the natural ceiling.
 */
export const MIN_PREFERRED_DAY = 1;
export const MAX_PREFERRED_DAY = 28;

const scheduleFrequency = z.enum(SCHEDULE_FREQUENCIES, {
  errorMap: () => ({
    message: `frequency must be one of: ${SCHEDULE_FREQUENCIES.join(", ")}`,
  }),
});

const amountCents = z
  .number({ required_error: "amountCents is required", invalid_type_error: "amountCents must be a number" })
  .int("amountCents must be a whole number of cents")
  .positive("amountCents must be greater than zero")
  .max(MAX_SCHEDULE_AMOUNT_CENTS, `amountCents must be at most ${MAX_SCHEDULE_AMOUNT_CENTS}`);

const preferredDay = z
  .number({ invalid_type_error: "preferredDay must be a number" })
  .int("preferredDay must be a whole number")
  .min(MIN_PREFERRED_DAY, `preferredDay must be at least ${MIN_PREFERRED_DAY}`)
  .max(MAX_PREFERRED_DAY, `preferredDay must be at most ${MAX_PREFERRED_DAY}`);

/**
 * A calendar date as `yyyy-MM-dd`.
 *
 * The shape check alone is not enough — "2026-02-31" matches the pattern but is
 * not a real date, and `new Date()` would roll it over to March 3. The refine
 * step round-trips the parsed value through UTC and requires the components to
 * come back unchanged, which rejects both rollovers and NaN dates.
 */
const isoCalendarDate = z
  .string({ required_error: "startDate is required", invalid_type_error: "startDate must be a string" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be a calendar date in yyyy-MM-dd format")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return (
      parsed.getUTCFullYear() === y &&
      parsed.getUTCMonth() === m - 1 &&
      parsed.getUTCDate() === d
    );
  }, "startDate must be a real calendar date");

/**
 * `end_condition` has defaulted to 'targetDate' since the initial schema
 * (0000_initial_schema.sql) and no other value is produced anywhere in the
 * codebase or client.
 */
export const createScheduleSchema = z.object({
  frequency: scheduleFrequency,
  amountCents,
  startDate: isoCalendarDate,
  preferredDay: preferredDay.nullable().optional(),
  endCondition: z.literal("targetDate").optional(),
}).strict();

/** Every field optional — PATCH applies only the keys that are present. */
export const updateScheduleSchema = z.object({
  frequency: scheduleFrequency.optional(),
  amountCents: amountCents.optional(),
  preferredDay: preferredDay.nullable().optional(),
  isPaused: z.boolean({ invalid_type_error: "isPaused must be a boolean" }).optional(),
}).strict();

// ─── Jar schemas ──────────────────────────────────────────────────────────────

/**
 * The approved jar categories, in catalogue order.
 *
 * Mirrors `artifacts/mobile/lib/jar-categories.ts` and the `CreateJarRequest`
 * enum in `lib/api-spec/openapi.yaml`; `jar-category-contract.test.ts` asserts
 * all three agree.
 *
 * ─── STRICT ON WRITE, TOLERANT ON READ ───────────────────────────────────────
 *
 * This list is enforced when a jar is created, and deliberately NOT enforced by
 * a database CHECK constraint. Those are not the same decision.
 *
 * `jars.category` is free text and predates this list. The development database
 * holds 82 jars with the legacy value 'travel' and 1 with 'Other'. A CHECK
 * constraint would either fail to apply or require rewriting historical rows,
 * and rejecting those rows on read would break jars that work today. So legacy
 * values continue to load, and the client's `resolveCategory()` renders
 * anything it does not recognise as `Other`.
 *
 * What the validation stops is *new* arbitrary values entering the column, so
 * the set of legacy oddities stays fixed and shrinks over time rather than
 * growing.
 */
export const JAR_CATEGORIES = [
  "Vacation",
  "Cruise",
  "MissionTrip",
  "Wedding",
  "Honeymoon",
  "Reunion",
  "Celebration",
  "HomeDownPayment",
  "Vehicle",
  "LargePurchase",
  "Education",
  "EmergencyFund",
  "BusinessProject",
  "FamilyGoal",
  "Other",
] as const;

export type JarCategory = (typeof JAR_CATEGORIES)[number];

/**
 * How precisely the organizer knows the target date.
 *
 * `target_date` is stored as a real calendar date at every precision — coarser
 * values are normalised to the start of their period — so this affects display
 * only. See migration 0024 and `lib/db/src/schema/index.ts`.
 */
export const TARGET_DATE_PRECISIONS = ["exact", "monthYear", "year"] as const;

export type TargetDatePrecision = (typeof TARGET_DATE_PRECISIONS)[number];

export const DEFAULT_TARGET_DATE_PRECISION: TargetDatePrecision = "exact";

const jarCategory = z.enum(JAR_CATEGORIES, {
  errorMap: () => ({
    message: `category must be one of: ${JAR_CATEGORIES.join(", ")}`,
  }),
});

const targetDatePrecision = z.enum(TARGET_DATE_PRECISIONS, {
  errorMap: () => ({
    message: `targetDatePrecision must be one of: ${TARGET_DATE_PRECISIONS.join(", ")}`,
  }),
});

/**
 * The fields of a jar-create request that carry a closed set of values.
 *
 * Deliberately narrow. The create handler validates the rest of the body with
 * its own long-standing checks (name, targetDate and goalAmountCents required;
 * goal ≥ $1.00; cutoff before target), and replacing all of that wholesale
 * would change error shapes that existing clients and tests depend on. This
 * schema adds a contract where there was none, without disturbing one that
 * already works.
 *
 * Both fields are optional so an older client that sends neither still
 * succeeds: category keeps its historical 'Vacation' default, and precision
 * falls back to 'exact', which is what every jar created before this column
 * was implicitly asserting.
 */
export const createJarContractSchema = z.object({
  category: jarCategory.optional(),
  targetDatePrecision: targetDatePrecision.optional(),
});

/** Same closed-set fields on the PATCH path. Category is not editable. */
export const updateJarContractSchema = z.object({
  targetDatePrecision: targetDatePrecision.optional(),
});

// ─── Validation middleware factory ────────────────────────────────────────────

import { type Request, type Response, type NextFunction } from "express";
import { type ZodSchema, ZodError } from "zod";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields = formatZodError(result.error);
      res.status(400).json({
        error: "ValidationError",
        message: "Request validation failed",
        fields,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Parse a request body inside a handler rather than as middleware.
 *
 * Returns the parsed value, or `null` after having already sent a 400. Use when
 * validation must run *after* other checks in the handler — e.g. schedule
 * routes, where membership and jar-phase checks must still return 403/404 for
 * an unauthorized caller regardless of whether the body is well-formed.
 *
 * Emits the same response shape as the `validate()` middleware.
 */
export function validateBody<T>(
  schema: ZodSchema<T>,
  body: unknown,
  res: Response,
): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({
      error: "ValidationError",
      message: "Request validation failed",
      fields: formatZodError(result.error),
    });
    return null;
  }
  return result.data;
}

function formatZodError(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}
