import { Router } from "express";
import path from "path";
import fs from "fs";

const router = Router();

const PDF_PATH = path.join(process.cwd(), "../../TripJar-Codebase.pdf");

router.get("/download/codebase", (_req, res) => {
  if (!fs.existsSync(PDF_PATH)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="TripJar-Codebase.pdf"');
  res.sendFile(PDF_PATH);
});

export default router;
