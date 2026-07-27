import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { tripsRouter } from "./api/trips.js";
import { observationsRouter } from "./api/observations.js";
import { settingsRouter } from "./api/settings.js";

// A transient MongoDB hiccup (e.g. Atlas dropping an idle connection) can
// surface as an unhandled rejection from the driver's internal reconnect
// logic, which crashes the whole process by Node's default behavior — for
// a long-running server this turns "the DB blipped for a second" into
// "the entire API is down until someone notices and restarts it." Log and
// keep running instead; Mongoose's own connection handling retries queries
// once the connection recovers.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (server staying up):", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server staying up):", err);
});

// Phase 3 (MASTER_SPEC Section 16): the real API the frontend's
// StoreProvider is migrated onto, screen by screen.
const app = express();
app.use(cors()); // single-user personal tool — no origin whitelist needed
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/trips", tripsRouter);
app.use("/api/observations", observationsRouter);
app.use("/api/settings", settingsRouter);

async function start(): Promise<void> {
  await connectDB();
  console.log("Connected to MongoDB.");
  app.listen(env.port, () => {
    console.log(`FlySmart API listening on port ${env.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
