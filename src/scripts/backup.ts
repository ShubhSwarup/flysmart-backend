import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { connectDB, disconnectDB } from "../config/db.js";
import { Trip } from "../models/Trip.js";
import { Observation } from "../models/Observation.js";
import { Notification } from "../models/Notification.js";
import { Settings } from "../models/Settings.js";

// Section 13.5 — MongoDB Atlas's free M0 tier has no automated backups, and
// this data (years of price history across trips) can't be recreated if
// lost. Deviates from the spec's literal "runs mongoexport" in one way:
// dumps each collection via the driver directly instead of shelling out to
// the mongoexport binary, so the GitHub Actions runner doesn't need the
// separate MongoDB Database Tools install — same end result (one JSON file
// per collection), one less moving part.
async function dumpCollection(name: string, docs: unknown[], outDir: string): Promise<void> {
  const filePath = path.join(outDir, `${name}.json`);
  await writeFile(filePath, JSON.stringify(docs, null, 2));
  console.log(`Wrote ${docs.length} ${name} document(s) to ${filePath}`);
}

async function run(): Promise<void> {
  const outDir = process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups");
  let connected = false;
  try {
    await connectDB();
    connected = true;
    console.log("Connected to MongoDB.");

    await mkdir(outDir, { recursive: true });

    await dumpCollection("trips", await Trip.find({}).lean(), outDir);
    await dumpCollection("observations", await Observation.find({}).lean(), outDir);
    await dumpCollection("notifications", await Notification.find({}).lean(), outDir);
    await dumpCollection("settings", await Settings.find({}).lean(), outDir);

    console.log("Backup complete.");
  } catch (err) {
    console.error("Backup failed:", err);
    process.exitCode = 1;
  } finally {
    if (connected) await disconnectDB();
  }
}

run();
