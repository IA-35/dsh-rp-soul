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
    async function api(path, init) {
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
     *   GET    /rp-soul/engine/persona    用引擎校验人设（不落盘）
     *   GET    /rp-soul/engine/session    读这一局的上下文（session_id）
     *   GET    /rp-soul/engine/mood       某人心情面板（session_id + npc_id）
     *   DELETE /rp-soul/engine/thought    手动删一条情绪（m03587 的 debug 入口）
     */
    function EngineCard(props) {
      const { snap, onNotify, onSaved } = props;
      const [eng, setEng] = useState(null);
      const [check, setCheck] = useState(null);
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
                revision: session.revision,
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
        [session, npc, onNotify, openMood]
      );

      const runCheck = useCallback(async () => {
        setBusy(true);
        setCheck(null);
        try {
          const data = await api("/engine/persona");
          if (!alive.current) return;
          setCheck(data);
          if (data && data.ok === true) onNotify("ok", "人设能开局");
        } catch (error) {
          onNotify("error", "校验失败：" + error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [onNotify]);

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
        h("button", { style: S.btn, disabled: busy, onClick: load }, "刷新"),
        h("button", { style: S.btn, disabled: busy || !ready, onClick: runCheck }, "校验人设")
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
      const castN = Array.isArray(front.cast) ? front.cast.length : 0;
      const placeN = Array.isArray(front.places) ? front.places.length : 0;
      const structureLine = h(
        "p",
        { style: S.hint },
        (eng && eng.persona && eng.persona.title ? "《" + eng.persona.title + "》" : "（未命名）")
          + " · 前置块：" + (Object.keys(front).length > 0 ? Object.keys(front).join(" / ") : "无")
          + " · " + castN + " 个角色 / " + placeN + " 个地点"
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

      const checkBlock = check === null
        ? null
        : h(
            "div",
            { style: { marginTop: 8 } },
            h(
              "p",
              { style: statusStyle(check.ok === true ? "ok" : "error") },
              check.ok === true
                ? "校验通过：引擎认这份人设，可以开局。"
                : "校验没通过：" + String(check.error || (check.details ? check.details.length + " 处问题" : ""))
            ),
            Array.isArray(check.details) && check.details.length > 0
              ? h(
                  "ul",
                  { style: { margin: "4px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: "20px", color: tok.label2 } },
                  check.details.slice(0, 12).map((d, i) =>
                    h("li", { key: i }, String(d.path || "") + "：" + String(d.reason || "")
                      + (d.hint ? " —— " + String(d.hint) : ""))
                  )
                )
              : null
          );

      const sessionLine = session === null
        ? h("p", { style: S.hint }, "这局还没开局（在对话里让 agent 调 soul_admin action=start）。")
        : h(
            "p",
            { style: S.hint },
            "当前局 " + String(session.session_id || "") + " · 第 " + String(session.turn ?? 0) + " 回合 · revision "
              + String(session.revision ?? 0)
              + (session.persona_title ? " · 《" + session.persona_title + "》" : "")
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
        checkBlock,
        sessionLine,
        moodHead
      );
    }

    /**
     * 设置页「角色人设」标签页。
     *
     * 布局：标题+总开关 → 状态文案 → 左「拼接顺序清单」右「编辑器」→ 高级项+合成预览。
     * 所有改动立即写回宿主（/rp-soul/config 或 /rp-soul/file），刷新页面不丢状态。
     */
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
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const notify = useCallback((kind, text) => {
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

      if (loading) {
        return h(
          "div",
          { style: S.root, "data-plugin": NS },
          h("p", { style: S.hint }, "正在读取角色预设…")
        );
      }

      if (snap === null) {
        return h(
          "div",
          { style: S.root, "data-plugin": NS },
          h("p", { style: statusStyle("error") }, msg ? msg.text : "无法读取配置"),
          h("button", { style: S.btn, onClick: refresh }, "重试")
        );
      }

      const headerRow = h(
        "div",
        { style: S.row },
        h("h2", { style: S.title }, "角色人设"),
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
        { style: S.root, "data-plugin": NS, "data-render-state": "ready" },
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
