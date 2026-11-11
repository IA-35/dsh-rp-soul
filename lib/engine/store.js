/* lib/engine/store.js — 存储：node:sqlite，一个文件 engine-v2.db。
 *
 * 只有这个文件认识 SQLite，外面只认这里导出的接口。六张表：
 *   ledger     一行一局，整份状态 JSON（全局只有一局，id 固定 "main"）
 *   snapshots  撤销用：每次交账之前的整份状态，按交账 id 存，留最近 30 份
 *   log        交账流水，一行一次（给「自主行动记录」页），超过 2000 行删最老的
 *   slots      命名存档
 *   common     常识库（全局，不挂局）
 *   meta       版本号
 *
 * 一次交账（写快照 + 换账本 + 记流水）在一个事务里，要么全成要么全不成。
 * node:sqlite 是同步的，进程内天然一次只有一个写；并发（比如同一份账本被两次提交）靠 revision 挡。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STORE_VERSION = 1;
const LEDGER_ID = "main";
const SNAPSHOT_KEEP = 30;
const LOG_KEEP = 2000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    n INTEGER PRIMARY KEY AUTOINCREMENT, ledger TEXT NOT NULL, commit_id TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS log (
    n INTEGER PRIMARY KEY AUTOINCREMENT, ledger TEXT NOT NULL, commit_id TEXT NOT NULL,
    at TEXT NOT NULL, summary TEXT NOT NULL, entry TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slots (
    name TEXT PRIMARY KEY, state TEXT NOT NULL, label TEXT NOT NULL, saved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS common (id TEXT PRIMARY KEY, row TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS snapshots_ledger ON snapshots(ledger, n);
  CREATE INDEX IF NOT EXISTS log_ledger ON log(ledger, n);
`;

/** 打开（没有就建）存储。返回的对象上是全部读写方法。 */
export function openStore(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
  if (version === undefined) {
    db.prepare("INSERT INTO meta(key, value) VALUES('version', ?)").run(String(STORE_VERSION));
  } else if (Number(version.value) > STORE_VERSION) {
    db.close();
    throw new Error("引擎库来自更新的版本（" + version.value + " > " + STORE_VERSION + "），请升级插件");
  }

  /** 常识表整张换掉（调用方负责包在事务里）。 */
  const writeCommon = (rows) => {
    db.exec("DELETE FROM common");
    const put = db.prepare("INSERT INTO common(id, row) VALUES(?, ?)");
    for (const row of rows) put.run(row.id, JSON.stringify(row));
  };

  /** 事务：fn 抛了就整个回滚。 */
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const q = {
    ledger: db.prepare("SELECT revision, state FROM ledger WHERE id = ?"),
    putLedger: db.prepare("INSERT INTO ledger(id, revision, state, updated_at) VALUES(?, ?, ?, ?) "
      + "ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state, updated_at = excluded.updated_at"),
    putSnapshot: db.prepare("INSERT INTO snapshots(ledger, commit_id, state, created_at) VALUES(?, ?, ?, ?)"),
    lastSnapshot: db.prepare("SELECT n, commit_id, state FROM snapshots WHERE ledger = ? ORDER BY n DESC LIMIT 1"),
    dropSnapshot: db.prepare("DELETE FROM snapshots WHERE n = ?"),
    trimSnapshots: db.prepare("DELETE FROM snapshots WHERE ledger = ? AND n NOT IN "
      + "(SELECT n FROM snapshots WHERE ledger = ? ORDER BY n DESC LIMIT ?)"),
    countSnapshots: db.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE ledger = ?"),
    putLog: db.prepare("INSERT INTO log(ledger, commit_id, at, summary, entry) VALUES(?, ?, ?, ?, ?)"),
    dropLog: db.prepare("DELETE FROM log WHERE ledger = ? AND commit_id = ?"),
    trimLog: db.prepare("DELETE FROM log WHERE ledger = ? AND n NOT IN "
      + "(SELECT n FROM log WHERE ledger = ? ORDER BY n DESC LIMIT ?)"),
    readLog: db.prepare("SELECT entry FROM log WHERE ledger = ? ORDER BY n DESC LIMIT ?"),
  };

  return {
    /** 当前这一局：{ revision, state } 或 null（还没开局）。 */
    ledger() {
      const row = q.ledger.get(LEDGER_ID);
      return row === undefined ? null : { revision: row.revision, state: JSON.parse(row.state) };
    },

    /** 开一局（已有就整局换掉；快照和流水一并清空，撤销退不回上一局）。 */
    create(state, now) {
      tx(() => {
        db.prepare("DELETE FROM snapshots WHERE ledger = ?").run(LEDGER_ID);
        db.prepare("DELETE FROM log WHERE ledger = ?").run(LEDGER_ID);
        q.putLedger.run(LEDGER_ID, state.revision, JSON.stringify(state), now);
      });
    },

    /**
     * 记一次交账：before 是交账前的状态（存成快照），after 是交账后的。
     * 账本里的 revision 必须还是 before.revision，否则就是有别的写抢先了：抛 stale。
     */
    commit({ before, after, id, entry, now, common }) {
      tx(() => {
        const current = q.ledger.get(LEDGER_ID);
        if (current === undefined || current.revision !== before.revision) {
          const error = new Error("局面已经变了");
          error.stale = true;
          error.revision = current?.revision ?? null;
          throw error;
        }
        q.putSnapshot.run(LEDGER_ID, id, JSON.stringify(before), now);
        q.trimSnapshots.run(LEDGER_ID, LEDGER_ID, SNAPSHOT_KEEP);
        q.putLedger.run(LEDGER_ID, after.revision, JSON.stringify(after), now);
        q.putLog.run(LEDGER_ID, id, entry.at, entry.summary, JSON.stringify(entry));
        q.trimLog.run(LEDGER_ID, LEDGER_ID, LOG_KEEP);
        // 这次交账提了常识：和账本一起写，要么都成要么都不成
        if (common !== undefined) writeCommon(common);
      });
    },

    /** 存一份命名存档（整份状态）。同名的已经有了且没说 overwrite：返回 false。 */
    saveSlot({ name, label, state, now, overwrite = false }) {
      const exists = db.prepare("SELECT 1 FROM slots WHERE name = ?").get(name) !== undefined;
      if (exists && !overwrite) return false;
      db.prepare("INSERT INTO slots(name, state, label, saved_at) VALUES(?, ?, ?, ?) "
        + "ON CONFLICT(name) DO UPDATE SET state = excluded.state, label = excluded.label, saved_at = excluded.saved_at")
        .run(name, JSON.stringify(state), label, now);
      return true;
    },

    /** 存档列表（新的在前），不带状态本身。 */
    slots() {
      return db.prepare("SELECT name, label, saved_at, state FROM slots ORDER BY saved_at DESC").all()
        .map((row) => ({ name: row.name, label: row.label, saved_at: row.saved_at, revision: JSON.parse(row.state).revision }));
    },

    /** 一份存档的状态；没有返回 null。 */
    slot(name) {
      const row = db.prepare("SELECT state FROM slots WHERE name = ?").get(name);
      return row === undefined ? null : JSON.parse(row.state);
    },

    deleteSlot(name) {
      return db.prepare("DELETE FROM slots WHERE name = ?").run(name).changes > 0;
    },

    /**
     * 原地换掉账本，revision 不变、不存快照、不记流水（记忆这类宿主在背后写的东西）。
     * 账本已经被别的写换掉了（revision 对不上）就抛 stale，调用方重读再来。
     */
    replace(state, now) {
      tx(() => {
        const current = q.ledger.get(LEDGER_ID);
        if (current === undefined || current.revision !== state.revision) {
          const error = new Error("局面已经变了");
          error.stale = true;
          throw error;
        }
        q.putLedger.run(LEDGER_ID, state.revision, JSON.stringify(state), now);
      });
    },

    /** 导入旧存档：整局换掉（快照和流水清空、换成导入的流水），常识库换成 common。一个事务。 */
    importLedger({ state, log, common, now }) {
      tx(() => {
        db.prepare("DELETE FROM snapshots WHERE ledger = ?").run(LEDGER_ID);
        db.prepare("DELETE FROM log WHERE ledger = ?").run(LEDGER_ID);
        q.putLedger.run(LEDGER_ID, state.revision, JSON.stringify(state), now);
        for (const entry of log) q.putLog.run(LEDGER_ID, entry.id, entry.at, entry.summary, JSON.stringify(entry));
        q.trimLog.run(LEDGER_ID, LEDGER_ID, LOG_KEEP);
        writeCommon(common);
      });
    },

    /** 常识库整张表（按编号排）。 */
    commonRows() {
      return db.prepare("SELECT row FROM common").all().map((r) => JSON.parse(r.row))
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    },

    /** 整张表换成 rows（设置页增删改都走这里）。 */
    putCommon(rows) {
      tx(() => writeCommon(rows));
    },

    /** 每次注入几条（存在 meta 里）；没设过返回 null。 */
    commonLimit() {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'common_limit'").get();
      return row === undefined ? null : Number(row.value);
    },

    setCommonLimit(limit) {
      db.prepare("INSERT INTO meta(key, value) VALUES('common_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(limit));
    },

    /**
     * 撤销上一次交账：回到它之前的那份状态。revision 不往回退（继续往上加），
     * 这样手里还拿着旧 revision 的提交照样会被挡住。没有可撤销的返回 null。
     */
    undo(now) {
      return tx(() => {
        const snap = q.lastSnapshot.get(LEDGER_ID);
        const current = q.ledger.get(LEDGER_ID);
        if (snap === undefined || current === undefined) return null;
        const restored = { ...JSON.parse(snap.state), revision: current.revision + 1 };
        q.putLedger.run(LEDGER_ID, restored.revision, JSON.stringify(restored), now);
        q.dropSnapshot.run(snap.n);
        q.dropLog.run(LEDGER_ID, snap.commit_id);
        return { state: restored, undone: snap.commit_id };
      });
    },

    /** 还能撤销几次。 */
    undoable() {
      return q.countSnapshots.get(LEDGER_ID).c;
    },

    /** 最近的交账流水，新的在前。 */
    log(limit = 50) {
      return q.readLog.all(LEDGER_ID, limit).map((row) => JSON.parse(row.entry));
    },

    /** 清空全部引擎数据（局、快照、流水、存档、常识），从零开始。 */
    wipe() {
      tx(() => {
        for (const table of ["ledger", "snapshots", "log", "slots", "common"]) db.exec("DELETE FROM " + table);
      });
    },

    close() {
      db.close();
    },
  };
}
