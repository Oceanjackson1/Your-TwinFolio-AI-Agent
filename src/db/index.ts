import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

let db: Database | null = null;

const APP_DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(__dirname, '../../data');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(APP_DATA_DIR, 'database.sqlite');

export async function initDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS Users (
      userId INTEGER PRIMARY KEY,
      username TEXT,
      language TEXT DEFAULT 'zh',
      isSubscribed INTEGER DEFAULT 0,
      activePartitionId INTEGER,
      connectedToUserId INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS Partitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      userId INTEGER NOT NULL,
      FOREIGN KEY(userId) REFERENCES Users(userId)
    );

    CREATE TABLE IF NOT EXISTS Documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fileId TEXT NOT NULL,
      fileName TEXT,
      storageType TEXT DEFAULT 'telegram',
      localPath TEXT,
      storageUrl TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      partitionId INTEGER NOT NULL,
      FOREIGN KEY(partitionId) REFERENCES Partitions(id)
    );

    CREATE TABLE IF NOT EXISTS InviteCodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      ownerUserId INTEGER NOT NULL,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(ownerUserId) REFERENCES Users(userId)
    );

    CREATE TABLE IF NOT EXISTS GroupBindings (
      chatId INTEGER PRIMARY KEY,
      boundUserId INTEGER NOT NULL,
      partitionId INTEGER,
      replyStyle TEXT DEFAULT 'concise',
      knowledgeMode TEXT DEFAULT 'strict',
      citationMode INTEGER DEFAULT 1,
      accessMode TEXT DEFAULT 'all_members',
      triggerMode TEXT DEFAULT 'mention_reply_slash',
      updatedBy INTEGER,
      updatedAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(partitionId) REFERENCES Partitions(id),
      FOREIGN KEY(boundUserId) REFERENCES Users(userId)
    );

    CREATE TABLE IF NOT EXISTS PartitionSettings (
      partitionId INTEGER PRIMARY KEY,
      personaPrompt TEXT DEFAULT '',
      questionMode TEXT DEFAULT 'auto',
      replyStyle TEXT DEFAULT 'balanced',
      knowledgeMode TEXT DEFAULT 'hybrid',
      citationMode INTEGER DEFAULT 1,
      updatedAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(partitionId) REFERENCES Partitions(id)
    );

    CREATE TABLE IF NOT EXISTS ConversationScopes (
      scopeKey TEXT PRIMARY KEY,
      ownerUserId INTEGER NOT NULL,
      participantUserId INTEGER NOT NULL,
      partitionId INTEGER,
      chatType TEXT NOT NULL,
      chatId INTEGER,
      profile TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ConversationMessages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scopeKey TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(scopeKey) REFERENCES ConversationScopes(scopeKey)
    );
  `);

  // Migration: add connectedToUserId if missing
  try {
    await db.exec(`ALTER TABLE Users ADD COLUMN connectedToUserId INTEGER DEFAULT NULL`);
  } catch (e: any) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`UPDATE InviteCodes SET code = UPPER(TRIM(code)) WHERE code IS NOT NULL`);
  } catch (e: any) {
    console.warn("Invite code normalization skipped:", e?.message || e);
  }

  const documentMigrations = [
    `ALTER TABLE Documents ADD COLUMN storageType TEXT DEFAULT 'telegram'`,
    `ALTER TABLE Documents ADD COLUMN localPath TEXT`,
    `ALTER TABLE Documents ADD COLUMN storageUrl TEXT`,
    `ALTER TABLE Documents ADD COLUMN createdAt TEXT DEFAULT (datetime('now'))`,
  ];

  for (const statement of documentMigrations) {
    try {
      await db.exec(statement);
    } catch (e: any) {
      // Column already exists, ignore.
    }
  }

  try {
    await db.exec(`UPDATE Documents SET storageType = COALESCE(storageType, 'telegram')`);
  } catch (e: any) {
    console.warn("Document storage normalization skipped:", e?.message || e);
  }

  const groupBindingMigrations = [
    `ALTER TABLE GroupBindings ADD COLUMN partitionId INTEGER`,
    `ALTER TABLE GroupBindings ADD COLUMN replyStyle TEXT`,
    `ALTER TABLE GroupBindings ADD COLUMN knowledgeMode TEXT`,
    `ALTER TABLE GroupBindings ADD COLUMN citationMode INTEGER`,
    `ALTER TABLE GroupBindings ADD COLUMN accessMode TEXT`,
    `ALTER TABLE GroupBindings ADD COLUMN triggerMode TEXT`,
    `ALTER TABLE GroupBindings ADD COLUMN updatedBy INTEGER`,
    `ALTER TABLE GroupBindings ADD COLUMN updatedAt TEXT`,
  ];

  for (const statement of groupBindingMigrations) {
    try {
      await db.exec(statement);
    } catch (e: any) {
      // Column already exists, ignore.
    }
  }

  try {
    await db.exec(`
      UPDATE GroupBindings
      SET
        partitionId = COALESCE(
          partitionId,
          (SELECT activePartitionId FROM Users WHERE userId = GroupBindings.boundUserId)
        ),
        replyStyle = COALESCE(replyStyle, 'concise'),
        knowledgeMode = COALESCE(knowledgeMode, 'strict'),
        citationMode = COALESCE(citationMode, 1),
        accessMode = COALESCE(accessMode, 'all_members'),
        triggerMode = COALESCE(triggerMode, 'mention_reply_slash'),
        updatedAt = COALESCE(updatedAt, datetime('now'))
    `);
  } catch (e: any) {
    console.warn("Group binding normalization skipped:", e?.message || e);
  }

  console.log("Database initialized.");
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}
