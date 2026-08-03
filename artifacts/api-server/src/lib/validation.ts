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
