import jwt from "jsonwebtoken";
import { type Request, type Response, type NextFunction } from "express";

const JWT_SECRET =
  process.env["JWT_SECRET"] ?? "tripjar-dev-secret-change-in-production";
const TOKEN_EXPIRY = "30d";

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail: string;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ error: "Unauthorized", message: "Missing or invalid auth token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      email: string;
    };
    (req as AuthenticatedRequest).userId = payload.userId;
    (req as AuthenticatedRequest).userEmail = payload.email;
    next();
  } catch {
    res
      .status(401)
      .json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}

export function signToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}
