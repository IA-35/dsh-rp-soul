/* lib/client.js — DSH Web 设置页「角色人设」标签页（包名 dsh-rp-soul）。
 *
 * 加载契约：宿主用 window.__ModuleLoader__.load({ id, factory }) 装载，id 必须等于包名。
 * factory 内只有 require 可用（react / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives），
 * 没有 JSX、没有打包器，UI 树一律 h()。
 *
 * 数据面：宿主侧注册了 /rp-soul 前缀路由（见 lib/index.js），前端只碰这几条：
 *   GET  /rp-soul/state        快照（配置 + 各文件元信息 + 库列表 + 合成预览）
 *   GET  /rp-soul/file?rel=..  读单个文件
 *   PUT  /rp-soul/file         写单个文件 {rel, text}
 *   POST /rp-soul/new          新建文件 {name, text}
 *   POST /rp-soul/config       写配置 {files, separator, annotate, enabled, maxBytes}
 */
window.__ModuleLoader__.load({
  id: "dsh-rp-soul",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useRef, useMemo } = React;
    const h = React.createElement;

    const ROUTE = "/rp-soul";
    const NS = "soul-persona";

    /** fetch 包装：非 2xx 抛异常并带上宿主给的 error 文案。 */
    // 每个 path 各自带一个自增序号：慢响应回来时若同一个 path 有更新的响应
    // 已经落地，就丢掉这条旧的。别的 path 的序号互不影响 —— 用一个全局序号
    // 会让慢的 /engine/memories 被同时发出的快 /wake 判死，面板无故不刷新。
    const apiSeqs = new Map();
    async function api(path, init) {
      const method = init && init.method ? String(init.method).toUpperCase() : "GET";
      const seq = method === "GET" ? (apiSeqs.get(path) ?? 0) + 1 : 0;
      if (seq !== 0) apiSeqs.set(path, seq);
      const res = await fetch(ROUTE + path, {
        cache: "no-store",
        headers: { "content-type": "application/json" },
        ...init,
      });
      const text = await res.text();
      let payload = null;
      try {
        payload = text === "" ? null : JSON.parse(text);
      } catch {
        payload = { error: text.slice(0, 200) };
      }
      if (!res.ok) {
        const error = new Error(payload && payload.error ? payload.error : "HTTP " + res.status);
        error.status = res.status;
        throw error;
      }
      if (seq !== 0 && seq < (apiSeqs.get(path) ?? 0)) {
        const stale = new Error("响应已过期");
        stale.stale = true;
        throw stale;
      }
      return payload;
    }

    // 转义字符一律用 fromCharCode 取，避免源码里出现真实换行/反斜杠转义。
    const CH_BACKSLASH = String.fromCharCode(92);
    const CH_LF = String.fromCharCode(10);
    const CH_CR = String.fromCharCode(13);
    const CH_TAB = String.fromCharCode(9);

    /** 真实分隔符 → 可读转义形式（两个换行 → 反斜杠 n 反斜杠 n）。 */
    function escapeSep(text) {
      if (typeof text !== "string") return "";
      const escN = CH_BACKSLASH + "n";
      const escT = CH_BACKSLASH + "t";
      return text
        .split(CH_CR + CH_LF).join(escN)
        .split(CH_LF).join(escN)
        .split(CH_CR).join(escN)
        .split(CH_TAB).join(escT);
    }

    /** 可读转义形式 → 真实分隔符；不认识的转义原样保留。 */
    function unescapeSep(text) {
      if (typeof text !== "string") return "";
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (ch !== CH_BACKSLASH || i + 1 >= text.length) {
          out += ch;
          continue;
        }
        const next = text.charAt(i + 1);
        if (next === "n") { out += CH_LF; i++; }
        else if (next === "r") { out += CH_CR; i++; }
        else if (next === "t") { out += CH_TAB; i++; }
        else if (next === CH_BACKSLASH) { out += CH_BACKSLASH; i++; }
        else out += ch;
      }
      return out;
    }

    /** 字节数 → 好读字符串。 */
    function fmtBytes(n) {
      if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0 B";
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      return (n / 1048576).toFixed(2) + " MB";
    }

    /** 把 idx 处的元素移到 to 处。 */
    function moveItem(list, idx, to) {
      if (to < 0 || to >= list.length || idx < 0 || idx >= list.length) return list;
      const out = list.slice();
      const [it] = out.splice(idx, 1);
      out.splice(to, 0, it);
      return out;
    }

    // 样式：只用少量 CSS 变量，缺失时退回硬编码值。
    const tok = {
      label: "var(--dsh-label-primary, #1f2328)",
      label2: "var(--dsh-label-secondary, #656d76)",
      border: "var(--dsh-border-default, #d0d7de)",
      bg: "var(--dsh-bg-secondary, #f6f8fa)",
      bgHover: "var(--dsh-bg-tertiary, #eaeef2)",
      accent: "var(--dsh-accent, #0969da)",
      danger: "var(--dsh-danger, #cf222e)",
      ok: "var(--dsh-success, #1a7f37)",
    };

    const S = {
      root: { display: "flex", flexDirection: "column", gap: 14, padding: "4px 2px 24px", color: tok.label },
      title: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: "24px" },
      hint: { margin: 0, fontSize: 12, lineHeight: "18px", color: tok.label2 },
      row: { display: "flex", alignItems: "center", gap: 8 },
      card: { border: "1px solid " + tok.border, borderRadius: 8, padding: 10, background: tok.bg },
      list: { display: "flex", flexDirection: "column", gap: 4 },
      item: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        border: "1px solid transparent",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 13,
      },
      itemActive: { border: "1px solid " + tok.accent, background: tok.bgHover },
      itemMissing: { color: tok.danger },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
      btn: {
        padding: "4px 10px",
        fontSize: 12,
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid " + tok.border,
        background: "transparent",
        color: tok.label,
      },
      btnPrimary: {
        padding: "4px 10px",
        fontSize: 12,
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid " + tok.accent,
        background: tok.accent,
        color: "#ffffff",
      },
      input: {
        padding: "4px 8px",
        fontSize: 13,
        borderRadius: 6,
        border: "1px solid " + tok.border,
        background: "transparent",
        color: tok.label,
        fontFamily: "inherit",
      },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: 240,
        padding: 10,
        fontSize: 13,
        lineHeight: "20px",
        borderRadius: 6,
        border: "1px solid " + tok.border,
        background: "transparent",
        color: tok.label,
        resize: "vertical",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      pre: {
        margin: 0,
        padding: 10,
        maxHeight: 220,
        overflow: "auto",
        fontSize: 12,
        lineHeight: "18px",
        borderRadius: 6,
        background: tok.bg,
        border: "1px solid " + tok.border,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      tag: { fontSize: 11, padding: "1px 6px", borderRadius: 10, background: tok.bgHover, color: tok.label2 },
    };

    /** 状态文案的颜色。 */
    function statusStyle(kind) {
      if (kind === "error") return { fontSize: 12, color: tok.danger };
      if (kind === "ok") return { fontSize: 12, color: tok.ok };
      return { fontSize: 12, color: tok.label2 };
    }

    /**
     * 设置页「引擎」卡：引擎健康 / 人设包结构 / 这一局的心情面板。
     *
     * 数据面（lib/index.js 的 /rp-soul 前缀路由）：
     *   GET    /rp-soul/engine            引擎健康 + 人设包摘要 + 会话映射
     *   GET    /rp-soul/engine/session    读这一局的上下文（session_id）
     *   GET    /rp-soul/engine/mood       某人心情面板（session_id + npc_id）
     *   DELETE /rp-soul/engine/thought    手动删一条情绪（m03587 的 debug 入口）
     */
    function EngineCard(props) {
      const { snap, onNotify, onSaved } = props;
      const [eng, setEng] = useState(null);
      const [busy, setBusy] = useState(false);
      const [npc, setNpc] = useState(null);
      const [panel, setPanel] = useState(null);
      const [title, setTitle] = useState("");
      const [pid, setPid] = useState("");
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = useCallback(async () => {
        try {
          const next = await api("/engine");
          if (!alive.current) return;
          setEng(next);
          const pack = next && next.persona ? next.persona : null;
          setTitle(pack !== null && typeof pack.title === "string" ? pack.title : "");
          setPid(pack !== null && typeof pack.personaId === "string" ? pack.personaId : "");
        } catch (error) {
          if (alive.current) onNotify("error", "读引擎状态失败：" + error.message);
        }
      }, [onNotify]);

      useEffect(() => {
        load();
      }, [load, snap]);

      const session = eng && eng.session ? eng.session : null;
      const health = eng && eng.health ? eng.health : null;

      const openMood = useCallback(
        async (npcId) => {
          if (session === null) return;
          setBusy(true);
          setNpc(npcId);
          try {
            const data = await api(
              "/engine/mood?session_id=" + encodeURIComponent(session.session_id) + "&npc_id=" + encodeURIComponent(npcId)
            );
            if (!alive.current) return;
            setPanel(data);
          } catch (error) {
            onNotify("error", "读心情面板失败：" + error.message);
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [session, onNotify]
      );

      const dropThought = useCallback(
        async (thought) => {
          if (session === null || npc === null) return;
          const label = thought && thought.label ? thought.label : "这条";
          if (!window.confirm("确定删掉「" + label + "」？删掉后引擎不再复述这件事（会留一条审计记录）。")) return;
          setBusy(true);
          try {
            const data = await api("/engine/thought", {
              method: "DELETE",
              body: JSON.stringify({
                session_id: session.session_id,
                npc_id: npc,
                thought_id: thought.id,
                revision: panel && panel.revision ? panel.revision : session.revision,
                reason: "设置页手动删除",
              }),
            });
            if (!alive.current) return;
            if (data && data.ok === false) onNotify("error", "删除失败：" + String(data.error || ""));
            else onNotify("ok", "已删除「" + label + "」");
            await openMood(npc);
          } catch (error) {
            onNotify("error", "删除失败：" + error.message);
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [session, npc, panel, onNotify, openMood]
      );

      const saveIdentity = useCallback(async () => {
        setBusy(true);
        try {
          await api("/config", { method: "POST", body: JSON.stringify({ title: title, personaId: pid }) });
          onNotify("ok", "已保存人设标识");
          await load();
          if (typeof onSaved === "function") await onSaved();
        } catch (error) {
          onNotify("error", "保存失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [title, pid, onNotify, load, onSaved]);

      /**
       * 账本作用域：global = 所有会话共用一局（默认），session = 一会话一局。
       * 切换只改配置、不迁移；旧的会话局会在下一次读取时被「接管」成全局局，
       * 所以从 session 切到 global 不会丢掉已经攒起来的心情与关系。
       */
      const toggleScope = useCallback(async () => {
        const now = eng && eng.scope === "session" ? "session" : "global";
        const next = now === "global" ? "session" : "global";
        setBusy(true);
        try {
          await api("/config", { method: "POST", body: JSON.stringify({ engineScope: next }) });
          onNotify("ok", next === "global" ? "已切成全局账本：所有会话共用一局" : "已切成按会话：每个会话各自一局");
          await load();
          if (typeof onSaved === "function") await onSaved();
        } catch (error) {
          onNotify("error", "切换失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [eng, onNotify, load, onSaved]);

      const ready = health !== null && health.ready === true;
      const badge = ready
        ? h("span", { style: { fontSize: 11, padding: "1px 6px", borderRadius: 10, color: tok.ok, border: "1px solid " + tok.ok } }, "已就绪")
        : h("span", { style: { fontSize: 11, padding: "1px 6px", borderRadius: 10, color: tok.danger, border: "1px solid " + tok.danger } }, "不可用");

      const head = h(
        "div",
        { style: Object.assign({}, S.row, { marginBottom: 8 }) },
        h("strong", { style: { fontSize: 13 } }, "引擎（账本）"),
        badge,
        h("div", { style: { flex: 1 } }),
        h("button", { style: S.btn, disabled: busy, onClick: load }, "刷新")
      );

      const healthLine = health === null
        ? h("p", { style: S.hint }, "正在查询引擎…")
        : h(
            "p",
            { style: S.hint },
            ready
              ? "Python " + (health.python && health.python.version ? health.python.version.join(".") : "?")
                + " · 数据目录 " + String(health.dataDir || "")
              : "原因：" + String((health.python && health.python.reason) || "未知")
                + "。没有引擎时插件只按人设散文演，不记任何账。"
          );

      const front = eng && eng.persona && eng.persona.front ? eng.persona.front : {};
      const flat = normalizeFront(front);
      const structureLine = h(
        "p",
        { style: S.hint },
        (eng && eng.persona && eng.persona.title ? "《" + eng.persona.title + "》" : "（未命名）")
          + " · " + (flat.name !== "" ? "角色：" + flat.name : "还没写角色名")
          + " · 作息 " + flat.routine.length + " 段"
          + (flat.legacy ? " · 旧格式（多角色），去「引擎人设」保存一次即可换成新格式" : "")
          + (eng && eng.persona && eng.persona.bytes ? " · 散文 " + fmtBytes(eng.persona.bytes) : "")
      );

      const personaError = eng && eng.persona && eng.persona.error
        ? h("p", { style: statusStyle("error") }, "人设有个文件读不了：" + String(eng.persona.error.message || ""))
        : null;

      const identityRow = h(
        "div",
        { style: Object.assign({}, S.row, { flexWrap: "wrap", marginTop: 6 }) },
        h("span", { style: S.hint }, "标识"),
        h("input", {
          style: Object.assign({}, S.input, { width: 160 }),
          value: title,
          placeholder: "人设标题（省略取前置块 title）",
          onChange: (e) => setTitle(e.target.value),
        }),
        h("input", {
          style: Object.assign({}, S.input, { width: 160 }),
          value: pid,
          placeholder: "persona_id（省略取前置块 id）",
          onChange: (e) => setPid(e.target.value),
        }),
        h("button", { style: S.btn, disabled: busy, onClick: saveIdentity }, "保存标识")
      );

      const sessionLine = session === null
        ? h("p", { style: S.hint }, "这局还没开局（下一次 soul_state 会自动开一局；也可让 agent 调 soul_admin action=start）。")
        : h(
            "p",
            { style: S.hint },
            "当前局 " + String(session.session_id || "") + " · 第 " + String(session.turn ?? 0) + " 次 · revision "
              + String(session.revision ?? 0)
              + (session.persona_title ? " · 《" + session.persona_title + "》" : "")
          );

      const scopeRow = h(
        "div",
        { style: Object.assign({}, S.row, { flexWrap: "wrap", marginTop: 6 }) },
        h("span", { style: S.hint }, "账本作用域"),
        h(
          "span",
          { style: S.tag },
          eng && eng.scope === "session" ? "按会话" : "全局"
        ),
        h("button", { style: S.btn, disabled: busy, onClick: toggleScope }, "切换"),
        h("span", { style: S.hint }, (eng && eng.scopeHint) || "")
      );

      const moodHead = panel !== null && Array.isArray(panel.thoughts)
        ? h(
            "div",
            { style: { marginTop: 8 } },
            h(
              "p",
              { style: Object.assign({}, S.hint, { marginBottom: 4 }) },
              String((panel.npc && panel.npc.name) || npc || "") + " 的心情 " + String(panel.value ?? "?") + " / 100（"
                + String(panel.band ?? "") + "）· 阈值 "
                + String(panel.thresholds ? panel.thresholds.open : "?") + " / "
                + String(panel.thresholds ? panel.thresholds.closed : "?") + " / "
                + String(panel.thresholds ? panel.thresholds.break : "?")
            ),
            panel.thoughts.length === 0
              ? h("p", { style: S.hint }, "（没有任何情绪条目）")
              : h(
                  "div",
                  { style: S.list },
                  panel.thoughts.map((t, i) =>
                    h(
                      "div",
                      { key: String(t.id || i), style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
                      h("span", { style: S.tag }, t.delta >= 0 ? "+" + t.delta : String(t.delta)),
                      h("span", { style: { flex: 1 } }, String(t.label || "")),
                      h("span", { style: S.hint }, t.kind === "memory" ? "记忆" : "情境"),
                      h(
                        "button",
                        {
                          style: Object.assign({}, S.btn, { padding: "0 6px", color: tok.danger, borderColor: tok.danger }),
                          disabled: busy,
                          title: "删掉这条情绪（留审计）",
                          onClick: () => dropThought(t),
                        },
                        "×"
                      )
                    )
                  )
                )
          )
        : null;

      return h(
        "div",
        { style: S.card },
        head,
        healthLine,
        structureLine,
        personaError,
        identityRow,
        sessionLine,
        scopeRow,
        moodHead
      );
    }

    // ───────────────────────── 情绪页 ─────────────────────────

    const BAND_LABEL = { open: "开心", normal: "平稳", closed: "低落", break: "难过" };

    /** 心情条：一条 0–100 的横槽，按 band 上色。 */
    function MoodBar(props) {
      const value = typeof props.value === "number" ? props.value : 0;
      const band = props.band;
      const color = band === "open" ? tok.ok : band === "break" ? tok.danger : band === "closed" ? "#bf8700" : tok.accent;
      return h(
        "div",
        { style: { position: "relative", height: 8, borderRadius: 4, background: tok.bgHover, overflow: "hidden", flex: 1 } },
        h("div", {
          style: {
            position: "absolute", left: 0, top: 0, bottom: 0,
            width: Math.max(0, Math.min(100, value)) + "%",
            background: color,
          },
        })
      );
    }

    /**
     * 设置页「情绪」页：所有 NPC 的心情面板一次取完。
     *
     * 数据面：GET    /rp-soul/engine          → 这一局的 session
     *        GET    /rp-soul/engine/moods    → 每个 NPC 的心情 + 对玩家的关系
     *        DELETE /rp-soul/engine/thought  → 删掉一条情绪（留审计）
     */
    function MoodPanel(props) {
      const { onNotify } = props;
      const alive = useRef(true);
      const [snap, setSnap] = useState(null);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const session = snap && snap.session ? snap.session : null;

      const loadPanel = useCallback(async (sid) => {
        setBusy(true);
        try {
          const next = await api("/engine/moods?session_id=" + encodeURIComponent(sid));
          if (!alive.current) return;
          if (next && next.ok === false) onNotify("error", "读情绪失败：" + String(next.error || ""));
          else setData(next);
        } catch (error) {
          if (alive.current) onNotify("error", "读情绪失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify]);

      const reload = useCallback(async () => {
        try {
          const next = await api("/engine");
          if (!alive.current) return;
          setSnap(next);
          const sid = next && next.session ? next.session.session_id : null;
          if (sid) await loadPanel(sid);
          else setData(null);
        } catch (error) {
          if (alive.current) onNotify("error", "读引擎状态失败：" + error.message);
        }
      }, [onNotify, loadPanel]);

      useEffect(() => { reload(); }, [reload]);

      const dropThought = useCallback(async (npcId, thought) => {
        if (session === null) return;
        const label = thought && thought.label ? thought.label : "这条";
        if (!window.confirm("确定删掉「" + label + "」？删掉后引擎不再复述这件事（会留一条审计记录）。")) return;
        setBusy(true);
        try {
          const res = await api("/engine/thought", {
            method: "DELETE",
            body: JSON.stringify({
              session_id: session.session_id,
              npc_id: npcId,
              thought_id: thought.id,
              revision: data && data.revision ? data.revision : session.revision,
              reason: "设置页手动删除",
            }),
          });
          if (!alive.current) return;
          if (res && res.ok === false) onNotify("error", "删除失败：" + String(res.error || ""));
          else onNotify("ok", "已删除「" + label + "」");
          await loadPanel(session.session_id);
        } catch (error) {
          onNotify("error", "删除失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [session, data, onNotify, loadPanel]);

      const head = h(
        "div",
        { style: Object.assign({}, S.row, { marginBottom: 8 }) },
        h("strong", { style: { fontSize: 13 } }, "情绪"),
        h("div", { style: { flex: 1 } }),
        data && data.clock_label ? h("span", { style: S.tag }, String(data.clock_label)) : null,
        h("button", { style: S.btn, disabled: busy, onClick: reload }, "刷新")
      );

      if (session === null) {
        return h("div", { style: S.card }, head,
          h("p", { style: S.hint }, "这局还没开局：下一次 soul_state 会自动开一局。"));
      }
      if (data === null) {
        return h("div", { style: S.card }, head, h("p", { style: S.hint }, "正在读情绪…"));
      }

      const limits = data.thresholds || {};
      const thresholdLine = h(
        "p",
        { style: S.hint },
        "阈值（人设可调）：开心 ≥ " + String(limits.open ?? "?") + " · 低落 < " + String(limits.closed ?? "?")
          + " · 难过 < " + String(limits.break ?? "?")
      );

      const npcs = Array.isArray(data.npcs) ? data.npcs : [];
      const cards = npcs.map((npc) => {
        const thoughts = Array.isArray(npc.thoughts) ? npc.thoughts : [];
        const conds = Array.isArray(npc.conditions) ? npc.conditions : [];
        return h(
          "div",
          { key: npc.id, style: Object.assign({}, S.card, { marginTop: 8 }) },
          h(
            "div",
            { style: Object.assign({}, S.row, { gap: 8 }) },
            h("strong", { style: { fontSize: 13 } }, String(npc.name || npc.id)),
            h("span", { style: S.tag }, npc.present ? "在你身边" : "不在你身边"),
            conds.length > 0 ? h("span", { style: S.tag }, conds.join(" / ")) : null,
            h("div", { style: { flex: 1 } }),
            h("span", { style: { fontSize: 12, color: tok.label2 } },
              String(npc.value) + " / 100 · " + String(BAND_LABEL[npc.band] || npc.band || ""))
          ),
          h("div", { style: Object.assign({}, S.row, { marginTop: 6 }) }, h(MoodBar, { value: npc.value, band: npc.band })),
          h(
            "p",
            { style: Object.assign({}, S.hint, { marginTop: 6 }) },
            "对你：信任 " + String(npc.trust ?? 0) + " · 张力 " + String(npc.tension ?? 0)
              + " · " + String(npc.stage_label || npc.stage || "") + "（基准 " + String(npc.base ?? "?") + "）"
              + (npc.can_act ? " · 可以自主行动" : " · 行动冷却中")
          ),
          thoughts.length === 0
            ? h("p", { style: S.hint }, "（没有任何情绪条目：心情 = 基准值）")
            : h(
                "div",
                { style: Object.assign({}, S.list, { marginTop: 6 }) },
                thoughts.map((t, i) =>
                  h(
                    "div",
                    { key: String(t.id || i), style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
                    h("span", { style: Object.assign({}, S.tag, { color: t.delta >= 0 ? tok.ok : tok.danger }) },
                      t.delta >= 0 ? "+" + t.delta : String(t.delta)),
                    h("span", { style: { flex: 1 } }, String(t.label || "")),
                    h("span", { style: S.hint }, t.kind === "memory" ? "记忆" : "情境"),
                    t.remaining_minutes !== null && t.remaining_minutes !== undefined
                      ? h("span", { style: S.hint }, "剩 " + String(t.remaining_minutes) + " 分")
                      : null,
                    h("button", {
                      style: Object.assign({}, S.btn, { padding: "0 6px", color: tok.danger, borderColor: tok.danger }),
                      disabled: busy,
                      title: "删掉这条情绪（留审计）",
                      onClick: () => dropThought(npc.id, t),
                    }, "×")
                  )
                )
              )
        );
      });

      const deletions = Array.isArray(data.deletions) ? data.deletions : [];
      const auditBlock = deletions.length === 0
        ? null
        : h(
            "div",
            { style: { marginTop: 8 } },
            h("p", { style: S.hint }, "手动删除记录（引擎不会再把它们算回来）"),
            h(
              "div",
              { style: S.list },
              deletions.slice(0, 10).map((d, i) =>
                h("div", { key: i, style: { fontSize: 12, color: tok.label2 } },
                  "第 " + String(d.turn) + " 次 · " + String(d.npc_id) + " · " + String(d.label || "")
                    + (d.delta ? "（" + (d.delta > 0 ? "+" : "") + String(d.delta) + "）" : ""))
              )
            )
          );

      return h(
        "div",
        { style: S.card },
        head,
        h("p", { style: S.hint }, "第 " + String(data.turn ?? 0) + " 次 · revision " + String(data.revision ?? 0)
          + (data.persona_title ? " · 《" + data.persona_title + "》" : "")),
        thresholdLine,
        npcs.length === 0 ? h("p", { style: S.hint }, "人设里还没有角色。") : null,
        cards,
        auditBlock
      );
    }

    // ───────────────────────── 自主行动记录页 ─────────────────────────

    const MODE_LABEL = {
      result: "你说的话成了事实",
      attempt: "你在尝试",
      rewrite: "其实……",
      continue: "你没说没做",
      wait: "时间在走",
    };

    const KIND_LABEL = { opening: "开局", commit: "对话", undo: "撤销", load: "读档", import: "导入" };

    /**
     * 设置页「自主行动记录」页：最近几次里 NPC 做了什么、关系怎么动。
     *
     * 数据面：GET /rp-soul/engine           → 这一局的 session
     *        GET /rp-soul/engine/activity  → 最近 N 次的行动 / 离屏片段 / 关系变化
     */
    function ActivityPanel(props) {
      const { onNotify } = props;
      const alive = useRef(true);
      const [snap, setSnap] = useState(null);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [limit, setLimit] = useState(20);

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const session = snap && snap.session ? snap.session : null;

      const reload = useCallback(async (want) => {
        const n = typeof want === "number" ? want : limit;
        setBusy(true);
        try {
          const next = await api("/engine");
          if (!alive.current) return;
          setSnap(next);
          const sid = next && next.session ? next.session.session_id : null;
          if (!sid) {
            setData(null);
            return;
          }
          const log = await api("/engine/activity?session_id=" + encodeURIComponent(sid) + "&limit=" + n);
          if (!alive.current) return;
          if (log && log.ok === false) onNotify("error", "读记录失败：" + String(log.error || ""));
          else setData(log);
        } catch (error) {
          if (alive.current) onNotify("error", "读记录失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify, limit]);

      useEffect(() => { reload(); }, []);

      const head = h(
        "div",
        { style: Object.assign({}, S.row, { marginBottom: 8 }) },
        h("strong", { style: { fontSize: 13 } }, "自主行动记录"),
        h("div", { style: { flex: 1 } }),
        h(
          "select",
          {
            style: Object.assign({}, S.input, { width: 104 }),
            value: limit,
            disabled: busy,
            onChange: (e) => {
              const n = Number(e.target.value);
              setLimit(n);
              reload(n);
            },
          },
          [10, 20, 50].map((n) => h("option", { key: n, value: n }, "最近 " + n + " 次"))
        ),
        h("button", { style: S.btn, disabled: busy, onClick: () => reload() }, "刷新")
      );

      if (session === null) {
        return h("div", { style: S.card }, head,
          h("p", { style: S.hint }, "这局还没开局：下一次 soul_state 会自动开一局。"));
      }
      if (data === null) {
        return h("div", { style: S.card }, head, h("p", { style: S.hint }, "正在读记录…"));
      }

      const counts = data.counts || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];

      const listOf = (title, items, render) =>
        items.length === 0
          ? null
          : h(
              "div",
              { style: { marginTop: 6 } },
              h("p", { style: S.hint }, title),
              h("div", { style: S.list },
                items.map((item, i) => h("div", { key: i, style: { fontSize: 12, lineHeight: "18px" } }, render(item))))
            );

      const rowBlock = (row) => {
        const actions = Array.isArray(row.actions) ? row.actions : [];
        const beats = Array.isArray(row.beats) ? row.beats : [];
        const responses = Array.isArray(row.responses) ? row.responses : [];
        const relations = Array.isArray(row.relations) ? row.relations : [];
        const thoughts = Array.isArray(row.thoughts) ? row.thoughts : [];
        const empty = actions.length + beats.length + responses.length + relations.length + thoughts.length === 0;
        return h(
          "div",
          { key: String(row.turn) + "-" + String(row.revision), style: Object.assign({}, S.card, { marginTop: 8 }) },
          h(
            "div",
            { style: Object.assign({}, S.row, { gap: 8 }) },
            h("strong", { style: { fontSize: 13 } }, "第 " + String(row.turn ?? 0) + " 次"),
            row.mode ? h("span", { style: S.tag }, String(MODE_LABEL[row.mode] || row.mode)) : null,
            row.kind === "commit" ? null : h("span", { style: S.tag }, String(KIND_LABEL[row.kind] || row.kind || "")),
            row.undone ? h("span", { style: Object.assign({}, S.tag, { color: tok.danger }) }, "已撤销") : null,
            h("div", { style: { flex: 1 } }),
            h("span", { style: S.hint }, String(row.created_at || "").replace("T", " ").slice(0, 19))
          ),
          row.summary ? h("p", { style: { margin: "6px 0 0", fontSize: 12, lineHeight: "18px" } }, String(row.summary)) : null,
          row.open_action ? h("p", { style: S.hint }, "停在这里：" + String(row.open_action)) : null,
          listOf("自主行动", actions, (a) =>
            String(a.kind_label || a.kind || "") + "·" + String(a.name || a.npc_id || "") + "：" + String(a.text || "")
              + (a.significant ? "（重大）" : "")),
          listOf("离屏片段", beats, (b) => String(b.name || b.npc_id || "") + "：" + String(b.summary || "")),
          listOf("对方的回应", responses, (r) =>
            String(r.name || r.npc_id || "") + "：" + String(r.label || "") + (r.note ? "（" + String(r.note) + "）" : "")),
          listOf("关系变化", relations, (r) =>
            String(r.from_name || r.from || "") + " 对 " + String(r.to_name || r.to || "")
              + "：信任 " + String(r.trust ?? 0) + " · 张力 " + String(r.tension ?? 0)
              + (r.stage_label || r.stage ? " · " + String(r.stage_label || r.stage) : "")),
          listOf("留下的情绪", thoughts, (t) =>
            String(t.name || t.npc_id || "") + "：" + String(t.label || "")
              + "（" + (t.delta > 0 ? "+" : "") + String(t.delta ?? 0) + "）"),
          empty && !row.summary ? h("p", { style: S.hint }, "（这次没有可显示的变化）") : null
        );
      };

      return h(
        "div",
        { style: S.card },
        head,
        h("p", { style: S.hint },
          "第 " + String(data.turn ?? 0) + " 次 · revision " + String(data.revision ?? 0)
            + " · 共 " + String(counts.turns ?? rows.length) + " 条记录 / " + String(counts.actions ?? 0) + " 次自主行动 / "
            + String(counts.beats ?? 0) + " 个离屏片段"
            + (data.clock_label ? " · " + String(data.clock_label) : "")),
        data.open_action ? h("p", { style: S.hint }, "当前停在这里：" + String(data.open_action)) : null,
        rows.length === 0 ? h("p", { style: S.hint }, "还没有任何记录。") : null,
        rows.map(rowBlock)
      );
    }

    /**
     * 设置页「角色人设」标签页。
     *
     * 布局：标题+总开关 → 状态文案 → 左「拼接顺序清单」右「编辑器」→ 高级项+合成预览。
     * 所有改动立即写回宿主（/rp-soul/config 或 /rp-soul/file），刷新页面不丢状态。
     */
    // ------------------------------------------------------------------
    // 引擎人设（表单）
    // ------------------------------------------------------------------

    /** 输入框统一样式：撑满所在格子，不撑破布局。 */
    const inputW = Object.assign({}, S.input, { width: "100%", boxSizing: "border-box" });
    const textareaW = Object.assign({}, S.textarea, { minHeight: 56, fontFamily: "inherit" });

    /** 标签 + 控件的一格。 */
    function fieldRow(labelText, node, hint) {
      return h(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 12, minWidth: 0 } },
        h("span", { style: { color: tok.label2 } }, labelText),
        node,
        hint ? h("span", { style: { color: tok.label2, fontSize: 11 } }, hint) : null
      );
    }

    /** 两列网格。 */
    function grid(children) {
      return h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
        children
      );
    }

    /** 小标题 + 右侧操作按钮的一行。 */
    function subHead(text, actions) {
      return h(
        "div",
        { style: Object.assign({}, S.row, { marginTop: 4 }) },
        h("strong", { style: { fontSize: 13 } }, text),
        h("div", { style: { flex: 1 } }),
        ...(Array.isArray(actions) ? actions : [])
      );
    }

    /** 只有一个角色时人设里属于「她」的那些键（旧格式里它们挂在 cast[] 下面）。 */
    const COMPANION_KEYS = ["name", "call", "gender", "age", "role", "adult_context", "appearance", "voices", "start_stage"];

    /**
     * 旧格式（多角色移植时的 places + cast）读成单人：第一个主要角色就是她，
     * 她的日程换成作息「在<地点名>」，其余角色和地点丢掉。和引擎 persona.from_legacy 同一套规则。
     */
    function fromLegacy(f) {
      const cast = Array.isArray(f.cast) ? f.cast.filter((m) => m !== null && typeof m === "object") : [];
      const member = cast.find((m) => (m.tier ?? "major") === "major") ?? cast[0] ?? {};
      const names = {};
      for (const p of Array.isArray(f.places) ? f.places : []) {
        if (p !== null && typeof p === "object") names[p.id] = p.name || p.id;
      }
      const out = {};
      for (const key of Object.keys(f)) {
        if (key !== "cast" && key !== "places" && key !== "channels") out[key] = f[key];
      }
      for (const key of COMPANION_KEYS) if (member[key] !== undefined) out[key] = member[key];
      if (typeof member.id === "string") out.id = member.id;
      const routine = (Array.isArray(member.schedule) ? member.schedule : [])
        .filter((s) => s !== null && typeof s === "object")
        .map((s) => ({ from: s.from, to: s.to, doing: ("在" + (names[s.location_id] || s.location_id || "原地")).slice(0, 40) }));
      if (routine.length > 0) out.routine = routine;
      return out;
    }

    /** 表单用的人设草稿：单人、平铺，补全成「每个格子都有值」。`legacy` 只给界面看，保存前去掉。 */
    function normalizeFront(front) {
      const raw = front !== null && typeof front === "object" && !Array.isArray(front) ? front : {};
      const legacy = Array.isArray(raw.cast);
      const f = legacy ? fromLegacy(raw) : raw;
      const limits = f.mood_thresholds !== null && typeof f.mood_thresholds === "object" ? f.mood_thresholds : {};
      const voices = f.voices !== null && typeof f.voices === "object" ? f.voices : {};
      // decision / goal / situation 不在人设里：动机由引擎按当下状态测算，不由人在这里填。
      return Object.assign({}, f, {
        id: typeof f.id === "string" ? f.id : "",
        title: typeof f.title === "string" ? f.title : "",
        name: typeof f.name === "string" ? f.name : "",
        call: typeof f.call === "string" ? f.call : "",
        gender: typeof f.gender === "string" ? f.gender : "female",
        age: typeof f.age === "number" ? f.age : 18,
        role: typeof f.role === "string" ? f.role : "",
        adult_context: typeof f.adult_context === "string" ? f.adult_context : "",
        appearance: typeof f.appearance === "string" ? f.appearance : "",
        voices: Object.assign({ surface: "", inner: "" }, voices),
        start_stage: typeof f.start_stage === "string" ? f.start_stage : "stranger",
        routine: Array.isArray(f.routine)
          ? f.routine.map((s) => Object.assign({ from: 0, to: 1439, doing: "" }, s))
          : [],
        mood_base: typeof f.mood_base === "number" ? f.mood_base : 50,
        mood_thresholds: {
          open: typeof limits.open === "number" ? limits.open : 75,
          closed: typeof limits.closed === "number" ? limits.closed : 45,
          break: typeof limits.break === "number" ? limits.break : 25,
        },
        legacy,
      });
    }

    /** 留空就等于没写的可选字段：引擎要么取默认（title 用名字），要么不收空串。 */
    const OPTIONAL_TEXT = ["title", "call", "role", "appearance", "adult_context"];

    /** 写回文件的那份：去掉只给界面用的 legacy 标记和留空的可选字段。 */
    function frontToSave(draft) {
      const out = Object.assign({}, draft);
      delete out.legacy;
      for (const key of OPTIONAL_TEXT) {
        if (typeof out[key] === "string" && out[key].trim() === "") delete out[key];
      }
      return out;
    }

    /** 不可变地改草稿里的某个字段（按路径）。 */
    function setIn(obj, path, value) {
      if (path.length === 0) return value;
      const [head, ...rest] = path;
      const copy = Array.isArray(obj) ? obj.slice() : Object.assign({}, obj);
      copy[head] = setIn(copy[head] === undefined || copy[head] === null ? {} : copy[head], rest, value);
      return copy;
    }

    /**
     * 「引擎人设」表单页。
     *
     * 数据面：
     *   GET /rp-soul/engine/persona-file   读 rp-soul/persona.md 的结构化字段
     *   PUT /rp-soul/engine/persona-file   整份覆盖写回 {front}
     *
     * 为什么单独一个文件：散文是给人读的提示词，塞 YAML 前置块既难改又会被原样
     * 注入提示词；结构化字段搬到这里，散文就能干净地只剩人设本身。
     */
    function EnginePersonaPanel(props) {
      const { onNotify } = props;
      const alive = useRef(true);
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState(false);
      const [check, setCheck] = useState(null);
      const [showYaml, setShowYaml] = useState(false);

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const load = useCallback(async () => {
        setBusy(true);
        try {
          const next = await api("/engine/persona-file");
          if (!alive.current) return;
          setData(next);
          setDraft(normalizeFront(next && next.front ? next.front : {}));
          setDirty(false);
        } catch (error) {
          if (alive.current) onNotify("error", "读引擎人设失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify]);

      useEffect(() => { load(); }, [load]);

      const patch = useCallback((path, value) => {
        setDraft((prev) => (prev === null ? prev : setIn(prev, path, value)));
        setDirty(true);
      }, []);

      const save = useCallback(async () => {
        if (draft === null) return;
        setBusy(true);
        setCheck(null);
        try {
          const next = await api("/engine/persona-file", {
            method: "PUT",
            body: JSON.stringify({ front: frontToSave(draft) }),
          });
          if (!alive.current) return;
          setData(next);
          setDirty(false);
          onNotify("ok", "已保存引擎人设");
        } catch (error) {
          onNotify("error", "保存失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [draft, onNotify]);

      const numeric = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : fallback;
      };

      // 作息在库里存的是「一天里的第几分钟」（0–1439），界面上按小时:分钟给人填。
      const pad2 = (n) => (n < 10 ? "0" + n : String(n));
      const minutesToClock = (minutes) => {
        const m = Number.isFinite(minutes) ? Math.trunc(minutes) : 0;
        const wrapped = ((m % 1440) + 1440) % 1440;
        return pad2(Math.floor(wrapped / 60)) + ":" + pad2(wrapped % 60);
      };
      // 解析 "7:30" / "07:30" / "24:00"；认不出来就返回 null（不写回，等用户改对）
      const clockToMinutes = (text) => {
        const matched = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(text));
        if (matched === null) return null;
        const hour = Number(matched[1]);
        const minute = Number(matched[2]);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        if (minute > 59) return null;
        if (hour > 24 || (hour === 24 && minute > 0)) return null;
        return (hour % 24) * 60 + minute;
      };

      if (data === null || draft === null) {
        return h("div", { style: S.card }, h("p", { style: S.hint }, busy ? "正在读引擎人设…" : "读不到引擎人设"));
      }

      const legacyNote = draft.legacy
        ? h("p", { style: S.hint },
            "这份是旧格式（多角色）：表单按第一个主要角色读成了「" + (draft.name || "?") + "」，"
            + "日程换成了作息。点「保存」写成单人格式，其他角色和地点不再保留。")
        : null;

      const migrationNote = data.exists === false && data.source === "legacy"
        ? h("p", { style: S.hint },
            "这个文件还没建。下面的内容是从散文前置块里读出来的（" + String(data.legacyRel || "已有文件") + "），"
            + "点「保存」就搬进 " + String(data.rel) + "，散文那边的前置块以后不再参与解析。")
        : data.exists === false
          ? h("p", { style: S.hint }, "还没有 " + String(data.rel) + "：填好点保存就会建出来。")
          : null;

      const errLine = data.error
        ? h("p", { style: statusStyle("error") }, "文件解析有问题：" + String(data.error))
        : null;

      // ---- 基础字段 ----
      const basic = grid([
        fieldRow("id（给引擎用，ASCII 小写，别用 player）",
          h("input", { style: inputW, value: draft.id, onChange: (e) => patch(["id"], e.target.value) })),
        fieldRow("标题",
          h("input", { style: inputW, value: draft.title, onChange: (e) => patch(["title"], e.target.value) }),
          "存档列表里显示的名字；留空就用角色名。"),
        fieldRow("心情基准（0–100）",
          h("input", { style: inputW, type: "number", min: 0, max: 100, value: String(draft.mood_base),
            onChange: (e) => patch(["mood_base"], numeric(e.target.value, draft.mood_base)) }),
          "开局时的心情起点。省略按 50。"),
      ]);

      const thresholdBlock = h("div", null,
        fieldRow("心情阈值（开心 ≥ / 低落 < / 难过 <）",
          h("div", { style: { display: "flex", gap: 6 } },
            h("input", { style: inputW, type: "number", min: 0, max: 100, value: String(draft.mood_thresholds.open),
              onChange: (e) => patch(["mood_thresholds", "open"], numeric(e.target.value, draft.mood_thresholds.open)) }),
            h("input", { style: inputW, type: "number", min: 0, max: 100, value: String(draft.mood_thresholds.closed),
              onChange: (e) => patch(["mood_thresholds", "closed"], numeric(e.target.value, draft.mood_thresholds.closed)) }),
            h("input", { style: inputW, type: "number", min: 0, max: 100, value: String(draft.mood_thresholds.break),
              onChange: (e) => patch(["mood_thresholds", "break"], numeric(e.target.value, draft.mood_thresholds.break)) })),
          "必须满足 0 ≤ 难过 < 低落 < 开心 ≤ 100，否则开局会被拒。"),
      );

      // ---- 角色（只有一个：你我之间的那个人）----
      const person = h("div", { style: Object.assign({}, S.card, { marginBottom: 8 }) },
        subHead("角色" + (draft.name ? "：" + draft.name : ""), []),
        grid([
          fieldRow("名字",
            h("input", { style: inputW, value: draft.name, onChange: (e) => patch(["name"], e.target.value) })),
          fieldRow("自称/称呼",
            h("input", { style: inputW, value: draft.call, onChange: (e) => patch(["call"], e.target.value) }),
            "留空就用名字。"),
          fieldRow("性别",
            h("select", { style: inputW, value: draft.gender,
              onChange: (e) => patch(["gender"], e.target.value) },
              h("option", { value: "female" }, "female"),
              h("option", { value: "male" }, "male"),
              h("option", { value: "nonbinary" }, "nonbinary"))),
          fieldRow("年龄（必须 ≥ 18）",
            h("input", { style: inputW, type: "number", min: 18, max: 120, value: String(draft.age),
              onChange: (e) => patch(["age"], numeric(e.target.value, draft.age)) })),
          fieldRow("开局态度",
            h("select", { style: inputW, value: draft.start_stage,
              onChange: (e) => patch(["start_stage"], e.target.value) },
              h("option", { value: "stranger" }, "陌生"),
              h("option", { value: "acquainted" }, "认识"),
              h("option", { value: "familiar" }, "熟络"),
              h("option", { value: "flirting" }, "暧昧"),
              h("option", { value: "testing" }, "试探"),
              h("option", { value: "intimate" }, "亲密"),
              h("option", { value: "committed" }, "稳定")),
            "开局时 TA（角色）对你的关系阶段；不填就是「陌生」。人设里写明是主仆或老相识，这里就别留陌生。"),
          fieldRow("身份/职业",
            h("input", { style: inputW, value: draft.role, onChange: (e) => patch(["role"], e.target.value) })),
          fieldRow("外貌",
            h("input", { style: inputW, value: draft.appearance,
              onChange: (e) => patch(["appearance"], e.target.value) })),
        ]),
        fieldRow("表面语态（怎么说出口）",
          h("textarea", { style: textareaW, value: draft.voices.surface,
            onChange: (e) => patch(["voices", "surface"], e.target.value) })),
        fieldRow("内心语态（心里怎么想）",
          h("textarea", { style: textareaW, value: draft.voices.inner,
            onChange: (e) => patch(["voices", "inner"], e.target.value) })),
        h("p", { style: S.hint },
          "TA（角色）现在想做什么由引擎按心情、关系、到期的事算出来，不由人填；性格写进人设提示词就够了。")
      );

      // ---- 作息：一天里某段时间 TA 通常在做什么（界面按 时:分 填，库里仍存 0–1439 的分钟数，可跨午夜）----
      const routineRows = draft.routine.map((slot, index) =>
        h("div", { key: "routine-" + index, style: Object.assign({}, S.row, { gap: 6, marginBottom: 6 }) },
          h("input", { style: inputW, type: "time", value: minutesToClock(slot.from),
            onChange: (e) => {
              const next = clockToMinutes(e.target.value);
              if (next !== null) patch(["routine", index, "from"], next);
            } }),
          h("span", { style: S.hint }, "到"),
          h("input", { style: inputW, type: "time", value: minutesToClock(slot.to),
            onChange: (e) => {
              const next = clockToMinutes(e.target.value);
              if (next !== null) patch(["routine", index, "to"], next);
            } }),
          h("input", { style: inputW, placeholder: "在做什么，如：在诊所上班", value: slot.doing,
            onChange: (e) => patch(["routine", index, "doing"], e.target.value) }),
          h("button", { style: S.btn, onClick: () => patch(["routine"],
            draft.routine.filter((_, i) => i !== index)) }, "删"))
      );

      let checkLine = null;
      if (check !== null) {
        if (check.ok === true) {
          checkLine = h("p", { style: statusStyle("ok") }, "引擎的说法：这份人设能开局。");
        } else {
          const rows = [h("p", { key: "head", style: statusStyle("error") },
            "引擎不认：" + String(check.error || "未知原因"))];
          if (Array.isArray(check.details)) {
            for (let i = 0; i < check.details.length; i += 1) {
              const item = check.details[i] || {};
              rows.push(h("p", { key: "d-" + i, style: S.hint },
                String(item.path || "") + "  " + String(item.reason || "")
                + (item.hint ? "（" + String(item.hint) + "）" : "")));
            }
          }
          checkLine = h("div", null, rows);
        }
      }

      return h("div", { style: S.card },
        subHead("引擎人设（" + String(data.rel) + "）", [
          h("span", { style: S.tag }, data.exists ? fmtBytes(data.bytes) : "还没建"),
          dirty ? h("span", { style: S.tag }, "未保存") : null,
          h("button", { style: S.btn, disabled: busy, onClick: () => setShowYaml(!showYaml) }, showYaml ? "收起 YAML" : "看 YAML"),
          h("button", { style: S.btn, disabled: busy, onClick: load }, "重读"),
          h("button", { style: S.btnPrimary, disabled: busy || draft === null, onClick: save }, "保存"),
        ]),
        h("p", { style: S.hint },
          "心情、关系、作息这些是引擎要的字段，跟人设提示词分开维护；散文那边写「TA 是谁、怎么说话」就够了。"),
        legacyNote,
        migrationNote,
        errLine,
        showYaml ? h("pre", { style: S.pre }, String(data.preview || "")) : null,
        basic,
        thresholdBlock,
        person,
        subHead("作息（从几点 / 到几点 / 在做什么）", [
          h("button", { style: S.btn, onClick: () => patch(["routine"],
            draft.routine.concat([{ from: 540, to: 1080, doing: "" }])) }, "加一段"),
        ]),
        routineRows.length > 0 ? h("div", null, ...routineRows)
          : h("p", { style: S.hint }, "没有作息：你不在时引擎不知道 TA 通常在干什么，离屏片段全靠模型自己想。"),
        h("div", { style: Object.assign({}, S.row, { marginTop: 8 }) },
          h("button", { style: S.btnPrimary, disabled: busy, onClick: save }, "保存"),
          h("button", { style: S.btn, disabled: busy || dirty, onClick: async () => {
            setBusy(true);
            setCheck(null);
            try {
              const res = await api("/engine/persona");
              if (alive.current) setCheck(res);
            } catch (error) {
              onNotify("error", "校验失败：" + error.message);
            } finally {
              if (alive.current) setBusy(false);
            }
          } }, "校验"),
          h("span", { style: S.hint }, dirty ? "先保存再校验，校验读的是文件。" : "")
        ),
        checkLine
      );
    }

    /** 各层的中文名与顺序（和引擎 domain/memories.py 一致）。 */
    const MEMORY_LAYERS = [["abm", "ABM"], ["scm", "SCM"], ["clpa", "CLPA"]];

    /**
     * 「记忆」页签：RimTalk-ExpandMemory 工作台的简化版。
     *
     * 数据面：
     *   GET    /rp-soul/engine/memories?session_id=   各层记忆、待交的总结 / 日记、删除审计
     *   PUT    /rp-soul/engine/memory                 改一条（内容 / 重要度 / 活跃度 / 关键词 / 备注 / Pin）
     *   DELETE /rp-soul/engine/memory                 删一条（留审计）
     *   POST   /rp-soul/engine/memory/request         立即汇总 / 立即写日记（下一次提交执行）
     */
    function MemoryPanel(props) {
      const { onNotify } = props;
      const alive = useRef(true);
      const [snap, setSnap] = useState(null);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [layer, setLayer] = useState("all");
      const [selected, setSelected] = useState(null);
      const [draft, setDraft] = useState(null);

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const session = snap && snap.session ? snap.session : null;

      const loadPanel = useCallback(async (sid) => {
        setBusy(true);
        try {
          const next = await api("/engine/memories?session_id=" + encodeURIComponent(sid));
          if (!alive.current) return;
          if (next && next.ok === false) onNotify("error", "读记忆失败：" + String(next.error || ""));
          else setData(next);
        } catch (error) {
          if (alive.current) onNotify("error", "读记忆失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify]);

      const reload = useCallback(async () => {
        try {
          const next = await api("/engine");
          if (!alive.current) return;
          setSnap(next);
          const sid = next && next.session ? next.session.session_id : null;
          if (sid) await loadPanel(sid);
          else setData(null);
        } catch (error) {
          if (alive.current) onNotify("error", "读引擎状态失败：" + error.message);
        }
      }, [onNotify, loadPanel]);

      useEffect(() => { reload(); }, [reload]);

      const revisionNow = () => (data && data.revision ? data.revision : session ? session.revision : undefined);

      /** 写操作的公共流程：发请求 → 提示 → 重读面板。 */
      const write = useCallback(async (path, method, body, okText) => {
        if (session === null) return null;
        setBusy(true);
        try {
          const res = await api(path, {
            method: method,
            body: JSON.stringify(Object.assign({ session_id: session.session_id, revision: revisionNow() }, body)),
          });
          if (!alive.current) return null;
          if (res && res.ok === false) {
            onNotify("error", String(res.error || "失败"));
            return null;
          }
          onNotify("ok", String((res && res.receipt) || okText));
          await loadPanel(session.session_id);
          return res;
        } catch (error) {
          onNotify("error", error.message);
          return null;
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [session, data, onNotify, loadPanel]);

      const pick = (entry) => {
        setSelected(entry.id);
        setDraft({
          content: entry.content,
          importance: entry.importance,
          activity: entry.activity,
          keywords: (entry.keywords || []).join("，"),
          note: entry.note || "",
          pinned: entry.pinned === true,
        });
      };

      const head = h(
        "div",
        { style: Object.assign({}, S.row, { marginBottom: 8, flexWrap: "wrap", rowGap: 6 }) },
        h("strong", { style: { fontSize: 13 } }, "记忆"),
        h("div", { style: { flex: 1 } }),
        data && data.clock_label ? h("span", { style: S.tag }, String(data.clock_label)) : null,
        h("button", { style: S.btn, disabled: busy || session === null,
          onClick: () => write("/engine/memory/request", "POST", { kind: "fold" }, "下一次提交会先把 ABM 收进 SCM") }, "立即汇总"),
        h("button", { style: S.btn, disabled: busy || session === null,
          onClick: () => write("/engine/memory/request", "POST", { kind: "diary" }, "下一次提交会先写今天的日记") }, "立即写日记"),
        h("button", { style: S.btn, disabled: busy, onClick: reload }, "刷新")
      );

      if (session === null) {
        return h("div", { style: S.card }, head, h("p", { style: S.hint }, "这局还没开局：下一次 soul_state 会自动开一局。"));
      }
      if (data === null) {
        return h("div", { style: S.card }, head, h("p", { style: S.hint }, "正在读记忆…"));
      }

      const entries = Array.isArray(data.entries) ? data.entries : [];
      const counts = data.counts || {};
      const capacity = data.capacity || {};
      const filterBtn = (key, label) =>
        h("button", {
          key: key,
          style: Object.assign({}, S.btn, layer === key ? { borderColor: tok.accent, color: tok.accent, fontWeight: 600 } : {}),
          onClick: () => setLayer(key),
        }, key === "all" ? label : label + " " + String(counts[key] ?? 0) + "/" + (capacity[key] === null ? "不限" : String(capacity[key] ?? "?")));
      const filters = h("div", { style: Object.assign({}, S.row, { gap: 4, flexWrap: "wrap", marginBottom: 8 }) },
        filterBtn("all", "全部"), ...MEMORY_LAYERS.map(([key, label]) => filterBtn(key, label)));

      const pending = [];
      if (data.requests && data.requests.memory_fold) {
        pending.push("收进 SCM（" + String((data.requests.memory_fold.sources || []).length) + " 条）");
      }
      if (data.requests && data.requests.memory_diary) {
        pending.push("写日记（" + String((data.requests.memory_diary.sources || []).length) + " 条）");
      }
      const pendingLine = pending.length > 0
        ? h("p", { style: S.hint }, "下一次提交要先交：" + pending.join("、"))
        : null;

      // 纵向时间轴：ABM / SCM / CLPA，按日期分组，透明度 = 活跃度
      const shown = entries.filter((e) => layer === "all" || e.layer === layer);
      const groups = [];
      for (const e of shown) {
        // 「10.29 周四 14:00」去掉最后那截钟点，剩下的就是这一天的名字
        const parts = String(e.when || "").split(" ");
        const day = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
        const last = groups[groups.length - 1];
        if (last && last.day === day) last.items.push(e);
        else groups.push({ day: day, items: [e] });
      }
      const card = (e) => h("div", {
        key: e.id,
        style: Object.assign({}, S.card, {
          marginTop: 6, cursor: "pointer", opacity: 0.35 + 0.65 * Number(e.activity || 0),
          borderColor: selected === e.id ? tok.accent : undefined,
        }),
        onClick: () => pick(e),
      },
        h("div", { style: Object.assign({}, S.row, { gap: 6, flexWrap: "wrap" }) },
          h("span", { style: S.tag }, String(e.layer_label || e.layer)),
          e.pinned ? h("span", { style: S.tag }, "Pin") : null,
          Array.isArray(e.milestone) && e.milestone.length > 0 ? h("span", { style: S.tag }, "里程碑") : null,
          e.edited ? h("span", { style: S.tag }, "改过") : null,
          h("span", { style: S.hint }, String(e.when || "")),
          h("div", { style: { flex: 1 } }),
          h("span", { style: S.hint }, "重要度 " + Number(e.importance || 0).toFixed(2) + " · 活跃度 " + Math.round(Number(e.activity || 0) * 100) + "%")),
        h("p", { style: { margin: "4px 0 0", fontSize: 13 } }, String(e.content || "")),
        e.you ? h("p", { style: S.hint }, "你说：" + String(e.you)) : null,
        Array.isArray(e.quotes) && e.quotes.length > 0 ? h("p", { style: S.hint }, "她说：" + e.quotes.join(" / ")) : null
      );
      const timeline = groups.length === 0
        ? h("p", { style: S.hint }, "这一层还没有记忆。")
        : groups.map((g) => h("div", { key: g.day, style: { marginBottom: 8 } },
            h("p", { style: Object.assign({}, S.hint, { margin: "4px 0" }) }, g.day),
            g.items.map(card)));

      // 详情 / 编辑
      const current = entries.find((e) => e.id === selected) || null;
      const set = (key) => (ev) => setDraft(Object.assign({}, draft, { [key]: ev.target.type === "checkbox" ? ev.target.checked : ev.target.value }));
      const detail = current === null || draft === null
        ? null
        : h("div", { style: Object.assign({}, S.card, { marginTop: 8 }) },
            h("p", { style: Object.assign({}, S.hint, { marginTop: 0 }) },
              String(current.layer_label) + " · " + String(current.when) + " · " + String(current.id)
                + (current.origin_ids && current.origin_ids.length > 0 ? " · 由 " + current.origin_ids.length + " 条合成" : "")),
            fieldRow("内容", h("textarea", { style: textareaW, value: draft.content, onChange: set("content") })),
            fieldRow("重要度（0–1）", h("input", { style: inputW, type: "number", min: 0, max: 1, step: 0.05, value: String(draft.importance), onChange: set("importance") })),
            fieldRow("活跃度（0–1）", h("input", { style: inputW, type: "number", min: 0, max: 1, step: 0.05, value: String(draft.activity), onChange: set("activity") }),
              "改了就从这个值重新开始衰减。"),
            fieldRow("关键词（逗号分隔）", h("input", { style: inputW, value: draft.keywords, onChange: set("keywords") })),
            fieldRow("备注", h("input", { style: inputW, value: draft.note, onChange: set("note") })),
            h("label", { style: Object.assign({}, S.row, { gap: 6, fontSize: 12 }) },
              h("input", { type: "checkbox", checked: draft.pinned, onChange: set("pinned") }), "Pin（不衰减、不清理、不被挤掉）"),
            h("div", { style: Object.assign({}, S.row, { gap: 6, marginTop: 8 }) },
              h("button", { style: S.btnPrimary, disabled: busy, onClick: () => {
                // 只送改过的字段：原样送回去会被当成「你改过」，还会把存不回去的旧关键词再校验一遍
                const body = { memory_id: current.id };
                const words = String(draft.keywords).split(/[,，\s]+/).filter((k) => k !== "");
                if (draft.content !== current.content) body.content = draft.content;
                if (Number(draft.importance) !== Number(current.importance)) body.importance = Number(draft.importance);
                if (Number(draft.activity) !== Number(current.activity)) body.activity = Number(draft.activity);
                if (words.join("，") !== (current.keywords || []).join("，")) body.keywords = words;
                if (draft.note !== (current.note || "")) body.note = draft.note;
                if ((draft.pinned === true) !== (current.pinned === true)) body.pinned = draft.pinned === true;
                return write("/engine/memory", "PUT", body, "已保存");
              } }, "保存"),
              h("button", { style: Object.assign({}, S.btn, { color: tok.danger, borderColor: tok.danger }), disabled: busy, onClick: async () => {
                if (!window.confirm("确定删掉这条记忆？会留一条审计记录。")) return;
                const res = await write("/engine/memory", "DELETE", { memory_id: current.id, reason: "设置页手动删除" }, "已删除");
                if (res !== null && alive.current) { setSelected(null); setDraft(null); }
              } }, "删除"),
              h("button", { style: S.btn, onClick: () => { setSelected(null); setDraft(null); } }, "收起")));

      const deletions = Array.isArray(data.deletions) ? data.deletions : [];
      const audit = deletions.length === 0
        ? null
        : h("div", { style: { marginTop: 8 } },
            h("p", { style: S.hint }, "手动删除记录"),
            deletions.map((d, i) => h("p", { key: String(i), style: S.hint },
              "第 " + String(d.turn) + " 次 · " + String(d.content || "") + (d.reason ? "（" + String(d.reason) + "）" : ""))));

      return h("div", { style: S.card },
        head,
        h("p", { style: S.hint },
          "ABM 是这段对话里的原话，满 20 条或者搁置一小时，由子代理收成一条进 SCM；SCM 记着「多久以前」，约一个月淡掉。"
            + "CLPA 是她挑出来要一直记着的，不淡忘，你可以手动删改。"
            + "日记每晚 23:30 落成文件。卡片越淡，她记得越模糊；被提起会变清楚。"),
        pendingLine,
        filters,
        timeline,
        detail,
        audit
      );
    }

    // ------------------------------------------------------------------
    // 常识库（关键词 + 权重 + 一条常识，全局共享）
    // ------------------------------------------------------------------

    /**
     * 「常识库」页签：关键词 → 一条常识。全局的，换哪一局都是这一份。
     *
     * 数据面：GET/POST/PUT/DELETE /rp-soul/engine/common，
     *         PUT /rp-soul/engine/common/limit（每次注入几条）
     *
     * 注入只认「这句话里出现了关键词」：没命中的一条都不进上下文，
     * 所以这里的东西不会变成背景设定，只是一张随时能查的表。
     */
    function CommonPanel(props) {
      const { onNotify } = props;
      const alive = useRef(true);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState({ key: "", weight: "0.5", content: "" });
      const [editing, setEditing] = useState(null);
      const [edits, setEdits] = useState({});

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const reload = useCallback(async () => {
        setBusy(true);
        try {
          const next = await api("/engine/common");
          if (!alive.current) return;
          if (next && next.ok === false) onNotify("error", "读常识库失败：" + String(next.error || ""));
          else setData(next);
        } catch (error) {
          if (alive.current) onNotify("error", "读常识库失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify]);

      useEffect(() => { reload(); }, [reload]);

      /** 把一句「ds, deepseek」拆成关键词数组。 */
      const keysOf = (text) => String(text || "")
        .split(/[,，、\s]+/)
        .map((one) => one.trim())
        .filter((one) => one !== "");

      const send = useCallback(async (path, method, body, okText) => {
        setBusy(true);
        try {
          const res = await api(path, { method, body: JSON.stringify(body || {}) });
          if (!alive.current) return false;
          if (res && res.ok === false) {
            onNotify("error", String(res.error || "没成功"));
            return false;
          }
          onNotify("ok", String((res && res.receipt) || okText));
          await reload();
          return true;
        } catch (error) {
          if (alive.current) onNotify("error", error.message);
          return false;
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify, reload]);

      const add = useCallback(async () => {
        const keys = keysOf(draft.key);
        if (keys.length === 0) { onNotify("error", "先写一个关键词"); return; }
        if (String(draft.content).trim() === "") { onNotify("error", "还没写这条常识本身"); return; }
        const weight = Number(draft.weight);
        const done = await send("/engine/common", "POST", {
          key: keys,
          weight: Number.isFinite(weight) ? weight : 0.5,
          content: String(draft.content).trim(),
        }, "已加上");
        if (done) setDraft({ key: "", weight: "0.5", content: "" });
      }, [draft, send, onNotify]);

      /** 进入某一行的编辑态：把当前值抄进草稿。 */
      const beginEdit = useCallback((row) => {
        const keys = Array.isArray(row.key) ? row.key : [];
        setEdits((old) => Object.assign({}, old, {
          [row.id]: {
            keyText: keys.join(", "),
            weightText: String(row.weight),
            contentText: String(row.content || ""),
          },
        }));
        setEditing(row.id);
      }, []);

      const patchEdit = useCallback((id, patch) => {
        setEdits((old) => Object.assign({}, old, {
          [id]: Object.assign({}, old[id] || {}, patch),
        }));
      }, []);

      const save = useCallback(async (row) => {
        const cur = edits[row.id] || {};
        const keys = keysOf(cur.keyText);
        if (keys.length === 0) { onNotify("error", "关键词不能空着"); return; }
        const weight = Number(cur.weightText);
        const done = await send("/engine/common", "PUT", {
          common_id: row.id,
          key: keys,
          weight: Number.isFinite(weight) ? weight : 0.5,
          content: String(cur.contentText || "").trim(),
        }, "已改好");
        if (done) setEditing(null);
      }, [edits, send, onNotify]);

      const remove = useCallback(async (row) => {
        const keys = Array.isArray(row.key) ? row.key : [];
        if (!window.confirm("确定删掉「" + keys.join("、") + "」？\n以后这句话就不会再带出这条常识了。")) return;
        await send("/engine/common", "DELETE", { common_id: row.id }, "已删除");
      }, [send]);

      const setLimit = useCallback(async (limit) => {
        await send("/engine/common/limit", "PUT", { limit }, "已改");
      }, [send]);

      const head = h(
        "div",
        { style: Object.assign({}, S.row, { marginBottom: 8 }) },
        h("strong", { style: { fontSize: 13 } }, "常识库"),
        h("div", { style: { flex: 1 } }),
        h("button", { style: S.btn, disabled: busy, onClick: reload }, "刷新")
      );

      if (data === null) {
        return h("div", { style: S.card }, head, h("p", { style: S.hint }, "正在读常识库…"));
      }

      const rows = Array.isArray(data.rows) ? data.rows : [];
      const limit = Number(data.limit) || 4;
      const cell = (extra) => Object.assign({
        style: Object.assign({}, S.input, { width: "100%", boxSizing: "border-box" }),
      }, extra);
      const gridCols = { display: "grid", gridTemplateColumns: "150px 70px 1fr auto", gap: 6, alignItems: "center" };

      return h(
        "div",
        { style: S.card },
        head,
        h("p", { style: S.hint },
          "共 " + String(data.count ?? rows.length) + " 条。这句话里出现关键词，这条常识才会被带进上下文；"
            + "一句话命中好几条时，权重高的先注入。"
            + "不只是她和你之间的事——是「DS 指的是什么」这类随时要用到的常识。"),
        h("div", { style: Object.assign({}, S.row, { marginTop: 6 }) },
          h("span", { style: { fontSize: 12, color: tok.label2 } }, "每次注入"),
          h("select", Object.assign({}, cell(), {
            style: Object.assign({}, S.input, { width: 76 }),
            value: String(limit),
            disabled: busy,
            onChange: (event) => setLimit(Number(event.target.value)),
          }), [2, 3, 4].map((n) => h("option", { key: n, value: String(n) }, String(n) + " 条")))
        ),
        h("div", { style: Object.assign({}, gridCols, {
          marginTop: 8, paddingTop: 8, borderTop: "1px solid " + tok.border,
        }) },
          h("input", cell({
            placeholder: "关键词：ds, deepseek",
            value: draft.key,
            onChange: (event) => setDraft((old) => Object.assign({}, old, { key: event.target.value })),
          })),
          h("input", cell({
            type: "number", min: 0, max: 1, step: 0.1,
            value: draft.weight,
            onChange: (event) => setDraft((old) => Object.assign({}, old, { weight: event.target.value })),
          })),
          h("input", cell({
            placeholder: "这条常识本身，一句话说清",
            value: draft.content,
            onChange: (event) => setDraft((old) => Object.assign({}, old, { content: event.target.value })),
          })),
          h("button", { style: S.btnPrimary, disabled: busy, onClick: add }, "添加")
        ),
        rows.length === 0 ? h("p", { style: Object.assign({}, S.hint, { marginTop: 8 }) }, "还没有任何常识。") : null,
        h("div", { style: Object.assign({}, S.list, { marginTop: 8 }) },
          rows.map((row) => {
            const keys = Array.isArray(row.key) ? row.key : [];
            const cur = edits[row.id] || {};
            if (editing === row.id) {
              return h("div", {
                key: row.id,
                style: Object.assign({}, gridCols, {
                  padding: "6px 0", borderTop: "1px solid " + tok.border,
                }),
              },
                h("input", cell({
                  value: cur.keyText || "",
                  onChange: (event) => patchEdit(row.id, { keyText: event.target.value }),
                })),
                h("input", cell({
                  type: "number", min: 0, max: 1, step: 0.1,
                  value: cur.weightText || "",
                  onChange: (event) => patchEdit(row.id, { weightText: event.target.value }),
                })),
                h("input", cell({
                  value: cur.contentText || "",
                  onChange: (event) => patchEdit(row.id, { contentText: event.target.value }),
                })),
                h("div", { style: Object.assign({}, S.row, { gap: 4 }) },
                  h("button", { style: S.btnPrimary, disabled: busy, onClick: () => save(row) }, "保存"),
                  h("button", { style: S.btn, disabled: busy, onClick: () => setEditing(null) }, "取消")
                )
              );
            }
            return h("div", {
              key: row.id,
              style: { fontSize: 12, lineHeight: "18px", padding: "4px 0", borderTop: "1px solid " + tok.border },
            },
              h("div", { style: S.row },
                h("span", { style: S.tag }, keys.join("、")),
                h("strong", null, String(row.content || "")),
                h("div", { style: { flex: 1 } }),
                h("span", { style: { color: tok.label2 } }, "权重 " + String(row.weight)),
                h("button", { style: S.btn, disabled: busy, title: "改这条", onClick: () => beginEdit(row) }, "改"),
                h("button", { style: S.btn, disabled: busy, title: "删掉这条", onClick: () => remove(row) }, "删除")
              )
            );
          })
        )
      );
    }

    // ------------------------------------------------------------------
    // 唤醒（她按自己的时间醒来）
    // ------------------------------------------------------------------

    /** 引擎给的候选理由 → 中文（与 engine/rp_soul_engine/domain/structure.py 一致）。 */
    const WAKE_LABEL = {
      plan: "她说好做到的时间",
      promise: "你们的约定",
      event: "她自己的事",
      miss_you: "想你了",
      routine: "作息换段",
      manual: "你手动叫醒",
    };

    /** ISO 时间戳 → 本地「MM-DD HH:MM」，认不出来就原样返回。 */
    function fmtWakeAt(value) {
      if (typeof value !== "string" || value === "") return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return value;
      const pad = (n) => String(n).padStart(2, "0");
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function WakePanel(props) {
      const { onNotify } = props;
      const alive = useRef(true);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [quietDraft, setQuietDraft] = useState(null);

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const load = useCallback(async () => {
        setBusy(true);
        try {
          const next = await api("/wake");
          if (!alive.current) return;
          setData(next);
        } catch (error) {
          if (alive.current) onNotify("error", "读唤醒状态失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify]);

      useEffect(() => { load(); }, [load]);

      /** 改一项就存一项：唤醒配置是零散开关，没必要攒一个「保存」按钮。 */
      const save = useCallback(async (patch) => {
        setBusy(true);
        try {
          await api("/config", { method: "POST", body: JSON.stringify(patch) });
          await load();
        } catch (error) {
          onNotify("error", "保存失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify, load]);

      const wakeNow = useCallback(async () => {
        setBusy(true);
        try {
          const res = await api("/wake/now", { method: "POST", body: JSON.stringify({}) });
          if (!alive.current) return;
          if (res && res.ok === false) onNotify("error", "没能叫醒她：" + String(res.error || ""));
          else onNotify("ok", "已经叫醒她一次");
          await load();
        } catch (error) {
          onNotify("error", "叫醒失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify, load]);

      if (data === null) {
        return h("div", { style: S.card },
          h("p", { style: S.hint }, busy ? "正在读唤醒状态…" : "读不到唤醒状态"));
      }

      const cfg = data.config || {};
      const st = data.state || {};
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const enabled = cfg.enabled === true;
      const quietValue = quietDraft === null ? String(cfg.quiet === undefined ? "" : cfg.quiet) : quietDraft;

      const head = h(
        "div",
        { style: Object.assign({}, S.row, { marginBottom: 8 }) },
        h("strong", { style: { fontSize: 13 } }, "唤醒"),
        h("span", { style: S.tag }, data.mounted === true ? "已就绪" : "缺桌面宿主"),
        h("div", { style: { flex: 1 } }),
        h("button", { style: S.btn, disabled: busy, onClick: load }, "刷新")
      );

      const toggleRow = h("label", { style: Object.assign({}, S.row, { gap: 6, fontSize: 13 }) },
        h("input", {
          type: "checkbox",
          checked: enabled,
          disabled: busy,
          onChange: (e) => save({ wakeEnabled: e.target.checked }),
        }),
        "让她按自己的时间醒来",
        h("span", { style: S.hint }, "关着时不会自己醒，也可以随时手动叫一次。")
      );

      const sessionRow = fieldRow(
        "她醒在哪场对话里",
        h(
          "select",
          {
            style: inputW,
            value: cfg.sessionId || "",
            disabled: busy,
            onChange: (e) => save({ wakeSessionId: e.target.value }),
          },
          h("option", { value: "" }, sessions.length === 0 ? "还没有会话" : "选一场对话…"),
          sessions.map((item) => h("option", { key: item.sessionId, value: item.sessionId },
            (item.title || "（未命名）") + (item.sessionId === cfg.sessionId ? "（当前指定）" : "")))
        ),
        sessions.length === 0
          ? "会话列表要桌面宿主才有：命令行下拿不到，填了也不生效。"
          : (data.engineSession ? "这场对话已经有账本了。" : "这场对话还没开过局，她第一次醒时会自动开一局。")
      );

      const numbers = grid([
        fieldRow("每天最多叫醒（次，0 = 不限）",
          h("input", {
            style: inputW,
            type: "number",
            min: 0,
            max: 200,
            value: String(cfg.dailyLimit === undefined ? "" : cfg.dailyLimit),
            disabled: busy,
            onChange: (e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) save({ wakeDailyLimit: Math.trunc(n) });
            },
          }),
          "次数用完了当天就不再叫。"),
        fieldRow("每天最多用掉（token，0 = 不限）",
          h("input", {
            style: inputW,
            type: "number",
            min: 0,
            max: 100000000,
            value: String(cfg.dailyTokens === undefined ? "" : cfg.dailyTokens),
            disabled: busy,
            onChange: (e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) save({ wakeDailyTokens: Math.trunc(n) });
            },
          }),
          "按她醒来那几次的实际用量累计。"),
      ]);

      const extras = grid([
        fieldRow("多久没说话算「想你了」（小时，0 = 关）",
          h("input", {
            style: inputW,
            type: "number",
            min: 0,
            max: 96,
            value: String(cfg.missYou === undefined ? "" : cfg.missYou),
            disabled: busy,
            onChange: (e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) save({ wakeMissYou: Math.trunc(n) });
            },
          }),
          "你没回话时逐次拉长（6 → 12 → 24 小时）。"),
        fieldRow("安静时段（HH:MM-HH:MM，留空 = 不设）",
          h("input", {
            style: inputW,
            value: quietValue,
            disabled: busy,
            onChange: (e) => setQuietDraft(e.target.value),
            onBlur: (e) => {
              // 失焦才存：每敲一个字就写盘会把「01:0」这种半截值也存下去。
              save({ wakeQuiet: e.target.value });
              setQuietDraft(null);
            },
          }),
          "安静时段里只有她自己写下的安排能叫醒她。"),
      ]);

      const routineRow = h("label", { style: Object.assign({}, S.row, { gap: 6, fontSize: 13 }) },
        h("input", {
          type: "checkbox",
          checked: cfg.routine !== false,
          disabled: busy,
          onChange: (e) => save({ wakeRoutine: e.target.checked }),
        }),
        "作息换段也叫我",
        h("span", { style: S.hint }, "到点了按她人设里的作息换段叫醒她（比如该「下班」了）。")
      );

      const nextLine = st.at
        ? h("p", { style: { margin: 0, fontSize: 13 } },
            "下次：" + fmtWakeAt(st.at) + "　",
            h("span", { style: S.tag }, WAKE_LABEL[st.reason] || String(st.reason || "")),
            st.why ? h("span", { style: S.hint }, "　" + String(st.why)) : null)
        : h("p", { style: S.hint }, enabled ? "暂时没有该醒的时刻：等她写下安排、约好时间，或者你久不说话。" : "唤醒线关着。");

      const statusBox = h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        nextLine,
        h("p", { style: S.hint },
          "今天已唤醒 " + String(st.count === undefined ? 0 : st.count) + " 次 · 用掉 "
          + String(st.tokens === undefined ? 0 : st.tokens) + " token"
          + (st.lastDeliveredAt ? " · 上次 " + fmtWakeAt(st.lastDeliveredAt) : "")),
        st.lastError ? h("p", { style: statusStyle("error") }, "上次没叫成：" + String(st.lastError)) : null,
        data.mounted === false
          ? h("p", { style: statusStyle("error") }, "唤醒线要桌面宿主（设置页所在的那个进程）：命令行下它整条不启用。")
          : null
      );

      return h("div", { style: S.card },
        head,
        toggleRow,
        sessionRow,
        numbers,
        extras,
        routineRow,
        h("div", { style: Object.assign({}, S.row, { marginTop: 4 }) },
          h("button", { style: S.btnPrimary, disabled: busy, onClick: wakeNow }, "现在叫醒一次"),
          h("span", { style: S.hint }, "绕过时刻与安静时段，但照样计入今天的次数。")
        ),
        subHead("状态", null),
        statusBox,
        h("p", { style: S.hint }, "唤醒消息用第一人称；措辞模板可以放 rp-soul/wake.md 自己改。")
      );
    }

    function SoulSection() {
      const [snap, setSnap] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [selected, setSelected] = useState(null);
      const [draft, setDraft] = useState("");
      const [dirty, setDirty] = useState(false);
      const [newName, setNewName] = useState("");
      const [previewOpen, setPreviewOpen] = useState(false);
      const [tab, setTab] = useState("persona");
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const notify = useCallback((kind, text) => {
        // 过期的响应（已被更新的响应取代）不算错误，别弹提示。
        if (String(text).includes("响应已过期")) return;
        if (alive.current) setMsg({ kind: kind, text: text });
      }, []);

      const refresh = useCallback(async () => {
        try {
          const next = await api("/state");
          if (!alive.current) return null;
          setSnap(next);
          setLoading(false);
          return next;
        } catch (error) {
          if (!alive.current) return null;
          setLoading(false);
          notify("error", "读取配置失败：" + error.message);
          return null;
        }
      }, [notify]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const saveConfig = useCallback(
        async (patch) => {
          setBusy(true);
          try {
            const res = await api("/config", { method: "POST", body: JSON.stringify(patch) });
            notify("ok", "已保存");
            await refresh();
            return res;
          } catch (error) {
            notify("error", "保存失败：" + error.message);
            return null;
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [notify, refresh]
      );

      const openFile = useCallback(
        async (rel) => {
          if (dirty && selected !== null && !window.confirm("当前文件有未保存的修改，确定切换吗？")) return;
          setBusy(true);
          try {
            const res = await api("/file?rel=" + encodeURIComponent(rel));
            if (!alive.current) return;
            setSelected(rel);
            setDraft(res && typeof res.text === "string" ? res.text : "");
            setDirty(false);
            setMsg(null);
            if (!res || res.exists !== true) notify("info", "该文件还不存在，保存后会创建");
          } catch (error) {
            notify("error", "读取文件失败：" + error.message);
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [dirty, selected, notify]
      );

      // 首次加载后自动选中一个文件：否则右边永远是「（未选择文件）」，
      // 用户得自己猜「要先点左边才能看内容」。
      // 优先挑清单里第一个**真实存在**的文件 —— 清单可能含还没建的路径，
      // 自动落到缺失文件上会让人以为坏了。
      const autoPicked = useRef(false);
      useEffect(() => {
        if (autoPicked.current) return;
        if (snap === null || selected !== null) return;
        const list = snap.config && Array.isArray(snap.config.files) ? snap.config.files : [];
        if (list.length === 0) return;
        const infos = Array.isArray(snap.files) ? snap.files : [];
        const present = list.filter((rel) => {
          const hit = infos.filter((it) => it && it.rel === rel)[0];
          return hit !== undefined && hit.exists === true;
        });
        autoPicked.current = true;
        openFile(present.length > 0 ? present[0] : list[0]);
      }, [snap, selected, openFile]);

      const saveFile = useCallback(async () => {
        if (selected === null) return;
        setBusy(true);
        try {
          await api("/file", { method: "PUT", body: JSON.stringify({ rel: selected, text: draft }) });
          if (!alive.current) return;
          setDirty(false);
          notify("ok", "已保存 " + selected);
          await refresh();
        } catch (error) {
          notify("error", "保存失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [selected, draft, notify, refresh]);

      const createFile = useCallback(async () => {
        const name = newName.trim();
        if (name === "") return;
        setBusy(true);
        try {
          const res = await api("/new", { method: "POST", body: JSON.stringify({ name: name, text: "" }) });
          if (!alive.current) return;
          setNewName("");
          const next = await refresh();
          if (res && res.rel) {
            const current = next && next.config && Array.isArray(next.config.files) ? next.config.files : [];
            if (current.indexOf(res.rel) === -1) await saveConfig({ files: current.concat([res.rel]) });
            await openFile(res.rel);
          }
          notify("ok", "已新建 " + (res && res.rel ? res.rel : name));
        } catch (error) {
          notify("error", "新建失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [newName, refresh, saveConfig, openFile, notify]);

      const files = snap && snap.config && Array.isArray(snap.config.files) ? snap.config.files : [];
      const library = snap && Array.isArray(snap.library) ? snap.library : [];
      const composed = snap && snap.composed ? snap.composed : null;
      const enabled = snap && snap.config ? snap.config.enabled !== false : true;
      const fileInfos = snap && Array.isArray(snap.files) ? snap.files : [];
      const addable = useMemo(
        () => library.filter((rel) => files.indexOf(rel) === -1),
        [library, files]
      );

      // 三个页签共用的一行：分区标题 + 页签按钮。
      // 情绪页与自主行动记录页自己读 /engine，不依赖人设页的 snap，所以放在 loading 判断之前。
      const tabBtn = (key, label) =>
        h(
          "button",
          {
            key: key,
            style: Object.assign({}, S.btn, tab === key ? { borderColor: tok.accent, color: tok.accent, fontWeight: 600 } : {}),
            onClick: () => setTab(key),
          },
          label
        );
      const sectionHead = h(
        "div",
        { style: Object.assign({}, S.row, { flexWrap: "wrap", rowGap: 6 }) },
        h("h2", { style: S.title }, "角色人设"),
        h("div", { style: { flex: 1 } }),
        h(
          "div",
          { style: Object.assign({}, S.row, { gap: 4 }) },
          tabBtn("persona", "人设提示词"),
          tabBtn("engine", "引擎人设"),
          tabBtn("mood", "情绪"),
          tabBtn("memory", "记忆"),
          tabBtn("facts", "常识库"),
          tabBtn("activity", "自主行动记录"),
          tabBtn("wake", "唤醒")
        )
      );

      if (tab !== "persona") {
        const panel = tab === "engine"
          ? h(EnginePersonaPanel, { onNotify: notify })
          : tab === "mood"
            ? h(MoodPanel, { onNotify: notify })
            : tab === "memory"
              ? h(MemoryPanel, { onNotify: notify })
              : tab === "facts"
                ? h(CommonPanel, { onNotify: notify })
                : tab === "wake"
                ? h(WakePanel, { onNotify: notify })
                : h(ActivityPanel, { onNotify: notify });
        return h(
          "div",
          { style: S.root, "data-plugin": NS, "data-render-state": "ready", "data-tab": tab },
          sectionHead,
          panel
        );
      }

      if (loading) {
        return h(
          "div",
          { style: S.root, "data-plugin": NS, "data-tab": tab },
          sectionHead,
          h("p", { style: S.hint }, "正在读取角色预设…")
        );
      }

      if (snap === null) {
        return h(
          "div",
          { style: S.root, "data-plugin": NS, "data-tab": tab },
          sectionHead,
          h("p", { style: statusStyle("error") }, msg ? msg.text : "无法读取配置"),
          h("button", { style: S.btn, onClick: refresh }, "重试")
        );
      }

      const headerRow = h(
        "div",
        { style: S.row },
        h("strong", { style: { fontSize: 13 } }, "人设提示词"),
        h("span", { style: S.tag }, files.length + " 个文件"),
        h("span", { style: S.tag }, composed ? fmtBytes(composed.bytes) : "0 B"),
        h("div", { style: { flex: 1 } }),
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" } },
          h("input", {
            type: "checkbox",
            checked: enabled,
            disabled: busy,
            onChange: (e) => saveConfig({ enabled: e.target.checked }),
          }),
          "启用"
        )
      );

      const statusLine = msg
        ? h("p", { style: statusStyle(msg.kind) }, msg.text)
        : null;

      /** 清单里的一行：文件名 + 大小 + 上移/下移/移除。 */
      const renderRow = (rel, idx) => {
        const info = fileInfos.filter((f) => f.rel === rel)[0];
        const missing = !!info && info.exists === false;
        const rowStyle = Object.assign({}, S.item, selected === rel ? S.itemActive : {}, missing ? S.itemMissing : {});
        const smallBtn = (label, title, disabled, onClick) =>
          h(
            "button",
            { style: Object.assign({}, S.btn, { padding: "0 6px" }), title: title, disabled: disabled, onClick: onClick },
            label
          );
        return h(
          "div",
          { key: rel, style: rowStyle, onClick: () => openFile(rel) },
          h("span", { style: Object.assign({}, S.mono, { flex: 1, wordBreak: "break-all" }) }, rel),
          missing ? h("span", { style: { fontSize: 11 } }, "缺失") : null,
          info && info.exists ? h("span", { style: { fontSize: 11, color: tok.label2 } }, fmtBytes(info.bytes)) : null,
          smallBtn("↑", "上移", busy || idx === 0, (e) => {
            e.stopPropagation();
            saveConfig({ files: moveItem(files, idx, idx - 1) });
          }),
          smallBtn("↓", "下移", busy || idx === files.length - 1, (e) => {
            e.stopPropagation();
            saveConfig({ files: moveItem(files, idx, idx + 1) });
          }),
          smallBtn("×", "从清单移除（不删文件）", busy, (e) => {
            e.stopPropagation();
            saveConfig({ files: files.filter((x) => x !== rel) });
            if (selected === rel) setSelected(null);
          })
        );
      };

      const addSelect = h(
        "select",
        {
          style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }),
          value: "",
          disabled: busy || addable.length === 0,
          onChange: (e) => {
            const rel = e.target.value;
            if (rel) saveConfig({ files: files.concat([rel]) });
          },
        },
        h("option", { value: "" }, addable.length === 0 ? "库里没有其它 .md/.txt" : "从库中添加…"),
        addable.map((rel) => h("option", { key: rel, value: rel }, rel))
      );

      const createRow = h(
        "div",
        { style: Object.assign({}, S.row, { marginTop: 8 }) },
        h("input", {
          style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }),
          placeholder: "新文件名，如 语气.md",
          value: newName,
          disabled: busy,
          onChange: (e) => setNewName(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") createFile();
          },
        }),
        h("button", { style: S.btn, disabled: busy || newName.trim() === "", onClick: createFile }, "新建")
      );

      const leftColumn = h(
        "div",
        { style: Object.assign({}, S.card, { flex: "0 0 320px", minWidth: 260 }) },
        h("div", { style: Object.assign({}, S.row, { marginBottom: 6 }) }, h("strong", { style: { fontSize: 13 } }, "拼接顺序")),
        files.length === 0
          ? h("p", { style: S.hint }, "还没有文件。用下面的「新建」或「从库中添加」。")
          : h("div", { style: S.list }, files.map(renderRow)),
        h("div", { style: Object.assign({}, S.row, { marginTop: 10 }) }, addSelect),
        createRow,
        h("p", { style: Object.assign({}, S.hint, { marginTop: 6 }) }, "新文件建在 rp-soul/parts/ 下，只接受 .md / .txt。")
      );

      const editorHeader = h(
        "div",
        { style: S.row },
        h("strong", { style: Object.assign({}, S.mono, { fontSize: 13 }) }, selected === null ? "（未选择文件）" : selected),
        selected === null ? null : h("span", { style: S.tag }, draft.length + " 字符"),
        dirty ? h("span", { style: Object.assign({}, S.tag, { color: tok.accent }) }, "未保存") : null,
        h("div", { style: { flex: 1 } }),
        h("button", { style: S.btnPrimary, disabled: busy || selected === null || !dirty, onClick: saveFile }, "保存"),
        h("button", { style: S.btn, disabled: busy || !dirty, onClick: () => openFile(selected) }, "还原")
      );

      const editorBody =
        selected === null
          ? h("p", { style: S.hint }, "从左边点一个文件开始编辑。")
          : h("textarea", {
              style: S.textarea,
              value: draft,
              spellCheck: false,
              placeholder: "这个文件还是空的 —— 直接在这里写。保存后下一条消息即生效。",
              onChange: (e) => {
                setDraft(e.target.value);
                setDirty(true);
              },
              onKeyDown: (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                  e.preventDefault();
                  saveFile();
                }
              },
            });

      const rightColumn = h(
        "div",
        { style: { flex: "1 1 420px", minWidth: 300, display: "flex", flexDirection: "column", gap: 8 } },
        editorHeader,
        editorBody,
        h("p", { style: S.hint }, "Ctrl/⌘+S 保存。")
      );

      const bodyRow = h(
        "div",
        { style: { display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" } },
        leftColumn,
        rightColumn
      );

      const toggleAnnotate = h(
        "label",
        { style: Object.assign({}, S.row, { fontSize: 12 }) },
        h("input", {
          type: "checkbox",
          checked: !!snap.config.annotate,
          disabled: busy,
          onChange: (e) => saveConfig({ annotate: e.target.checked }),
        }),
        "每段加 soul-part 注释"
      );

      const maxBytesInput = h(
        "label",
        { style: Object.assign({}, S.row, { fontSize: 12 }) },
        "总字节上限",
        h("input", {
          style: Object.assign({}, S.input, { width: 96 }),
          type: "number",
          min: 1024,
          max: 1048576,
          step: 1024,
          value: snap.config.maxBytes,
          disabled: busy,
          onChange: (e) => {
            const v = Number(e.target.value);
            if (isFinite(v) && v >= 1024) saveConfig({ maxBytes: Math.round(v) });
          },
        })
      );

      // 分隔符通常是两个换行；直接塞进单行 input 会显示成一片空白，看不出有没有值。
      // 所以显示/编辑都用转义形式（反斜杠 n），失焦时再转回真实字符。
      const sepInput = h(
        "label",
        { style: Object.assign({}, S.row, { fontSize: 12 }) },
        "分隔符",
        h("input", {
          style: Object.assign({}, S.input, { width: 72 }),
          value: escapeSep(snap.config.separator),
          disabled: busy,
          title: "支持反斜杠 n / t 转义；留空 = 各段直接相连",
          onChange: (e) => {
            const next = Object.assign({}, snap, {
              config: Object.assign({}, snap.config, { separator: unescapeSep(e.target.value) }),
            });
            setSnap(next);
          },
          onBlur: (e) => saveConfig({ separator: unescapeSep(e.target.value) }),
        })
      );

      const advancedRow = h(
        "div",
        { style: Object.assign({}, S.row, { flexWrap: "wrap", gap: 14 }) },
        toggleAnnotate,
        maxBytesInput,
        sepInput
      );

      const previewBlock = previewOpen
        ? h(
            "div",
            { style: { marginTop: 8 } },
            h(
              "p",
              { style: S.hint },
              "合成后 " + (composed ? composed.chars : 0) + " 字符 / " + (composed ? fmtBytes(composed.bytes) : "0 B")
            ),
            h("pre", { style: S.pre }, composed && composed.preview ? composed.preview : "（空）"),
            composed && composed.chars > 2000 ? h("p", { style: S.hint }, "（预览只显示前 2000 字符）") : null
          )
        : null;

      // ---- 引擎卡（P2）：引擎健康、人设包结构、这一局的心情面板 ----
      const engineCard = h(EngineCard, { snap: snap, onNotify: notify, onSaved: refresh });

      const advancedCard = h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: Object.assign({}, S.row, { marginBottom: 8 }) },
          h("strong", { style: { fontSize: 13 } }, "高级"),
          h("div", { style: { flex: 1 } }),
          h(
            "button",
            { style: S.btn, onClick: () => setPreviewOpen(!previewOpen) },
            previewOpen ? "隐藏合成预览" : "查看合成结果"
          )
        ),
        advancedRow,
        h("p", { style: Object.assign({}, S.hint, { marginTop: 6 }) }, "配置存放在 " + snap.storePath),
        previewBlock
      );

      return h(
        "div",
        { style: S.root, "data-plugin": NS, "data-render-state": "ready", "data-tab": tab },
        sectionHead,
        headerRow,
        h(
          "p",
          { style: S.hint },
          "按下列顺序拼接成一个系统提示段落，注入到 agent 的 persona 前缀位置。改完下一条消息即生效，无需重启。"
        ),
        statusLine,
        bodyRow,
        engineCard,
        advancedCard
      );
    }

    const name = "soul-persona-client";
    const inject = ["slots"];

    function apply(ctx) {
      // label 是 thunk，随语言切换；当前只有中文文案，直接返回常量。
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "soul-persona",
            order: 35,
            label: () => "角色人设",
            inject: () => ({}),
          },
          SoulSection
        )
      );
    }

    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  },
});
