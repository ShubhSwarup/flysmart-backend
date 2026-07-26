import express from "express";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";

// Minimal skeleton for Phase 1 (MASTER_SPEC Section 16) — proves the
// Express + Mongoose wiring works. Trip/observation CRUD routes land in
// Phase 3 once the frontend is ready to consume a real API.
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

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
