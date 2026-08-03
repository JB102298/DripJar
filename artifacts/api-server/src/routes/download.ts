import { Router } from "express";
import path from "node:path";
import fs from "node:fs";

const router = Router();

// Resolve once at startup so every request serves the same locked path.
// Using path.resolve + explicit validation prevents any path-traversal scenario
// even if process.cwd() were somehow manipulated at runtime.
const PDF_PATH = path.resolve(process.cwd(), "../../M3Jar-Codebase.pdf");

// Belt-and-suspenders: assert the resolved path is the file we expect and
// that it stays inside the workspace root (two directories above cwd).
const EXPECTED_BASENAME = "M3Jar-Codebase.pdf";
const WORKSPACE_ROOT = path.resolve(process.cwd(), "../..");

if (path.basename(PDF_PATH) !== EXPECTED_BASENAME) {
  throw new Error(
    `[download.ts] Resolved PDF path "${PDF_PATH}" has unexpected basename. ` +
    "Refusing to serve.",
  );
}
if (!PDF_PATH.startsWith(WORKSPACE_ROOT + path.sep)) {
  throw new Error(
    `[download.ts] Resolved PDF path "${PDF_PATH}" escapes workspace root "${WORKSPACE_ROOT}". ` +
    "Refusing to serve.",
  );
}

// GET /download/codebase
// Serves the most recently generated M3Jar-Codebase.pdf.
// No query parameters or user-supplied path segments are accepted.
// The file is re-read on every request so regeneration is reflected immediately.
router.get("/download/codebase", (_req, res) => {
  if (!fs.existsSync(PDF_PATH)) {
    res.status(404).json({
      error: "NotFound",
      message: "Codebase report has not been generated yet. Run: pnpm --filter @workspace/scripts run generate-pdf",
    });
    return;
  }

  // Send with no-cache so the browser always fetches the latest version
  // (important after a regeneration).
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${EXPECTED_BASENAME}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(PDF_PATH);
});

export default router;
