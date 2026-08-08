import { type Request, type Response, type NextFunction } from "express";

/**
 * Middleware that makes a route non-existent in production.
 *
 * Responds 404 (not 403) when `NODE_ENV === "production"` so the endpoint is
 * indistinguishable from an unmapped path — production must not confirm that a
 * developer-only route exists.
 *
 * Use for diagnostic and reporting endpoints that are useful during development
 * but must never be reachable on a deployed instance.
 */
export function devOnly(_req: Request, res: Response, next: NextFunction): void {
  if (process.env["NODE_ENV"] === "production") {
    res.status(404).json({ error: "NotFound", message: "Not found" });
    return;
  }
  next();
}
