/* 测试用：造一份旧引擎（Python）的 engine.db，带齐心事、约定、安排、状况、各种「谁知道」、记忆、常识、流水。 */
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

/** 在 oldFile 写一份旧库，最后一次交账是第 13 天 14:15（2026-11-11T14:15:26+08:00），局号 s_old。 */
export function makeV1Db(oldFile) {
  // ---- 造一份旧库：第 13 天 14:15 是最后一次交账（2026-11-11T14:15:26+08:00） ----
  const state = {
    persona_id: 'shorekeeper', persona_revision: 'r1', player_id: 'player',
    real_start: '2026-10-30T10:26:26+08:00', real_at: '2026-11-11T14:15:26+08:00', last_player_at: '2026-11-11T14:15:51+08:00',
    clock: { day: 13, minute: 855 },
    characters: {
      shorekeeper: {
        name: '守岸人',
        status: { conditions: [{ kind: 'busy', text: '在调灯', until: { day: 13, minute: 880 }, since_turn: 3 }, { kind: 'asleep', text: '早上睡过', until: { day: 13, minute: 400 }, since_turn: 1 }] },
        mood: { base: 70, thoughts: [
          { id: 'th3', label: '他把伞留给我', delta: 6, kind: 'memory', since_abs: 18100, expires_at: 18135 + 1440 },
          { id: 'th4', label: '早就过去的事', delta: -4, kind: 'memory', since_abs: 10000, expires_at: 11000 },
          { id: 'th5', label: '在场', delta: 3, kind: 'situational', since_abs: 18135, expires_at: null },
        ] },
      },
      player: { name: '灯塔看守' },
    },
    relationships: { 'shorekeeper>player': { trust: 2, tension: 1, stage: 'intimate', history: [{ turn: 2, change: 'trust+1', reason: '他说给我听' }] } },
    events: {
      e1: { id: 'e1', kind: 'promise', title: '周五去看海', participants: ['player', 'shorekeeper'], due: { day: 15, minute: 600 }, state: 'pending', created_turn: 2 },
      e2: { id: 'e2', kind: 'deadline', title: '把灯修好', participants: ['shorekeeper'], due: { day: 14, minute: 1200 }, state: 'pending', created_turn: 3 },
      e3: { id: 'e3', kind: 'rumor', title: '镇上的传言', participants: ['player'], due: null, state: 'pending', created_turn: 3 },
      e4: { id: 'e4', kind: 'promise', title: '早就兑现了', participants: ['player', 'shorekeeper'], due: { day: 10, minute: 600 }, state: 'resolved', created_turn: 1 },
    },
    counters: { next: { memory: 4 }, major_action_at: { shorekeeper: { day: 12, minute: 1300 } }, milestones: ['first_promise'], last_diary_day: 12 },
    scene: { since: { day: 13, minute: 829 }, responses: [] },
    plan: { note: '去调灯', until: { day: 13, minute: 900 }, set_turn: 3 },
    memory: {
      turns: [{ turn: 3, offscreen: [{ npc_id: 'shorekeeper', summary: '主人不在时她把灯罩擦了一遍' }] }],
      entries: [
        { id: 'm1', layer: 'scm', type: 'summary', content: '那几天一直在修灯', importance: 0.5, a0: 0.9, t0: 16000, at: { day: 12, minute: 900 }, turn: 1, keywords: ['修灯'], origin_ids: [], quotes: [], you: '', note: '', pinned: false, edited: false, summarized: false, diary_day: 12 },
        { id: 'm2', layer: 'clpa', type: 'conversation', content: '第一次说好去看海', importance: 0.8, a0: 1, t0: 17000, at: { day: 12, minute: 1000 }, turn: 2, keywords: ['看海'], origin_ids: [], quotes: [], you: '', note: '', pinned: true, edited: false, summarized: false, milestone: ['first_promise'] },
        { id: 'm3', layer: 'abm', type: 'conversation', content: '你：灯好了吗 她：快了', importance: 0.3, a0: 1, t0: 18135, at: { day: 13, minute: 855 }, turn: 3, keywords: ['灯好'], origin_ids: [], quotes: [], you: '灯好了吗', note: '', pinned: false, edited: false, summarized: false, remember: false },
      ],
      diary_last: { day: 12, text: '今天修了一天灯。' },
    },
    preferences: { pace: 'slow', explicitness: 'standard' },
    safety: { paused: false, boundaries: [] },
  };
  const facts = [
    { key: 'rain.umbrella', text: '他把伞留在门边', known_by: ['player', 'shorekeeper'], at: { day: 13, minute: 800 } },
    { key: 'her.secret.letter', text: '她藏了一封信', known_by: ['shorekeeper'], at: { day: 12, minute: 600 } },
    { key: 'you.cat', text: '他养了一只猫', known_by: ['player'], at: { day: 11, minute: 600 } },
    { key: 'nobody.knows', text: '谁都不知道', known_by: [], at: { day: 11, minute: 600 } },
  ];
  const db = new DatabaseSync(oldFile);
  db.exec(`CREATE TABLE sessions (session_id TEXT, state BLOB, updated_at TEXT);
    CREATE TABLE facts (session_id TEXT, n INTEGER, data TEXT, suppressed INTEGER);
    CREATE TABLE turn_log (id INTEGER PRIMARY KEY, session_id TEXT, turn INTEGER, kind TEXT, summary TEXT, open_action TEXT, undone INTEGER, created_at TEXT);
    CREATE TABLE common (n INTEGER, id TEXT, key TEXT, weight REAL, content TEXT, origin TEXT, pending INTEGER);`);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s_old', deflateSync(Buffer.from(JSON.stringify(state))), '2026-11-11T14:15:51+08:00');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s_older', deflateSync(Buffer.from(JSON.stringify({ ...state, persona_id: 'other' }))), '2026-10-01T00:00:00+08:00');
  facts.forEach((f, i) => db.prepare('INSERT INTO facts VALUES (?, ?, ?, ?)').run('s_old', i + 1, JSON.stringify(f), 0));
  db.prepare('INSERT INTO facts VALUES (?, ?, ?, ?)').run('s_old', 9, JSON.stringify({ key: 'gone', text: '删掉的', known_by: ['player', 'shorekeeper'] }), 1);
  const turn = (id, t, summary, undone, at) => db.prepare('INSERT INTO turn_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 's_old', t, 'commit', summary, null, undone, at);
  turn(1, 1, '第一次', 0, '2026-11-09T10:00:00+08:00');
  turn(2, 2, '说好看海', 0, '2026-11-10T16:40:00+08:00');
  turn(3, 3, '撤掉的那次', 1, '2026-11-11T13:00:00+08:00');
  turn(4, 3, '调灯', 0, '2026-11-11T14:15:00+08:00');
  db.prepare('INSERT INTO common VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 'c1', JSON.stringify(['ds']), 0.8, 'DS 指 deepseek', 'manual', 0);
  db.prepare('INSERT INTO common VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'c2', JSON.stringify(['灯塔']), 0.5, '旧的灯塔说法', 'manual', 0);
  db.close();

}
