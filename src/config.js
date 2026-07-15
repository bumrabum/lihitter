import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

const rootDir = process.cwd();

export const config = {
  port: Number(process.env.PORT || 3000),
  isLocal: (process.env.APP_MODE || "").toUpperCase() === "LOCAL",
  authUser: process.env.AUTH_USER || "admin",
  authPassword: process.env.AUTH_PASSWORD || "",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  rulesPath: path.resolve(rootDir, process.env.RULES_PATH || "./rules.json"),
  sessionPath: path.resolve(rootDir, process.env.SESSION_PATH || "./session.json"),
  settingsPath: path.resolve(rootDir, process.env.SETTINGS_PATH || "./settings.json"),
  dbPath: path.resolve(rootDir, process.env.DB_PATH || "./results.db"),
  gmailUser: process.env.GMAIL_USER || "",
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || "",
  gmailQuery: process.env.GMAIL_QUERY || "label:vacancies newer_than:1d",
};
