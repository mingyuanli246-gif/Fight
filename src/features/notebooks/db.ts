import Database from "@tauri-apps/plugin-sql";
import { DATABASE_PATH } from "./constants";

let databasePromise: Promise<Database> | null = null;

async function createDatabaseConnection() {
  const database = await Database.load(DATABASE_PATH);
  await database.execute("PRAGMA foreign_keys = ON");
  return database;
}

export async function getNotebookDatabase() {
  if (!databasePromise) {
    databasePromise = createDatabaseConnection().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

export async function closeNotebookDatabase() {
  if (!databasePromise) {
    return;
  }

  const database = await databasePromise;
  const closed = await database.close();

  if (!closed) {
    throw new Error("关闭本地数据库连接失败，请稍后重试。");
  }

  databasePromise = null;
}

export async function resetNotebookDatabase() {
  await closeNotebookDatabase();
}
