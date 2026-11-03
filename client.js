// dsh-needs-input browser half. Same wrapper format as every working client bundle in
// this profile (dsh-metafolder-plugin, dsh-anthropic-membership): a window.__ModuleLoader__
// factory. A bare function body (the dynamic-Cordis `cordis_define` form) is NOT what the
// profile's client-module scan executes - that was why the first rollout never rendered.
window.__ModuleLoader__.load({
  id: "dsh-needs-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const STORAGE_KEY = "dsh.needs-input.read-v1";
    // Marks seed only for activity older than this page's own start.
    const PAGE_LOADED_AT = Date.now();
    const YELLOW = "var(--dsw-alias-state-warning-primary, #f2c94c)";
    const GREEN = "var(--dsw-alias-state-success-primary, #45b36b)";
    const RED = "var(--dsw-alias-state-error-primary, #e5484d)";

    function readMarks() {
      try {
        const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch { return {}; }
    }
    function writeMarks(v) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* storage disabled */ }
    }

    // Host-side read marks (owner request 2026-10-28: "independent from the device that viewed chats").
    // The host plugin declares a settings namespace holding `acks` = {sessionId: {y,g,t}}; the settings
    // API is same-origin for every browser, so a chat read on the desktop is read on the phone too.
    // localStorage stays as a cache/fallback for when that API is unavailable.
    const ACK_NS_HINTS = ["needs-input-client", "dsh-needs-input", "needs-input"];
    const server = { ns: null, acks: {}, rows: [], revision: 0, loaded: false, remote: null };
    let pushTimer = null;

    /** Marks = the higher of the host store and the local cache, per chat and per colour. */
    function combineMarks(local, hostAcks) {
      const out = { ...local };
      for (const [id, ack] of Object.entries(hostAcks || {})) {
        for (const kind of ["y", "g"]) {
          const srv = Number(ack?.[kind] ?? 0);
          if (srv > Number(out[id + ":" + kind] ?? 0)) out[id + ":" + kind] = srv;
        }
      }
      return out;
    }

    /**
     * The mark to store for one chat once it has been viewed. An ERROR (red dot) is deliberately not
     * acknowledgeable: y stays where it is, so opening or reading the chat cannot clear it — only the
     * next message in that chat does (the host projection then sets needsInput back to "none").
     */
    function ackFor(state, existing) {
      const y = state?.needsInput === "error"
        ? Number(existing?.y ?? 0)
        : Math.max(Number(existing?.y ?? 0), Number(state?.needsInputSeq ?? 0));
      const g = Math.max(Number(existing?.g ?? 0), Number(state?.completedSeq ?? 0));
      return { y, g, t: Date.now() };
    }

    function pickNamespace(list) {
      const namespaces = list || [];
      for (const hint of ACK_NS_HINTS) {
        const hit = namespaces.find((n) => n.ns === hint);
        if (hit) return hit;
      }
      // fall back to the only namespace whose value carries `acks`
      return namespaces.find((n) => n?.value && typeof n.value === "object" && "acks" in n.value) || null;
    }

    async function loadServerAcks() {
      const remote = server.remote;
      if (!remote?.settings?.describe) return false;
      try {
        const described = await remote.settings.describe();
        // The typed remote wrapper returns the RPC envelope {ok, value:{namespaces,...}} (2026-10-28).
        const payload = described && described.value !== undefined ? described.value : described;
        if (described && described.ok === false) throw new Error(described.error?.message || "settings/describe refused");
        const ns = pickNamespace(payload?.namespaces);
        if (!ns) return false;
        server.ns = ns.ns;
        const rows = [ns.value?.acks, ns.user?.acks].find((v) => Array.isArray(v) && v.length) || [];
        server.rows = rows;
        server.acks = rowsToMap(server.rows);
        server.revision = Number(ns.revision ?? 0);
        server.loaded = true;
        return true;
      } catch { return false; }
    }

    function queuePush() {
      const remote = server.remote;
      if (!remote?.settings?.update || !server.ns) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(async () => {
        pushTimer = null;
        try {
          const res = await remote.settings.update(server.ns, { acks: mapToRows(server.acks, server.rows) }, server.revision);
          if (res && res.ok === false) throw new Error(res.error?.message || "settings/update refused");
          server.revision = Number(res?.value?.revision ?? server.revision + 1);
        } catch {
          // another device wrote first: re-read, merge ours back in, retry once
          const mine = server.acks;
          if (await loadServerAcks()) {
            server.acks = combineAckObjects(server.acks, mine);
            try { const r2 = await remote.settings.update(server.ns, { acks: mapToRows(server.acks, server.rows) }, server.revision); if (r2 && r2.ok === false) throw new Error(r2.error?.message); server.revision = Number(r2?.value?.revision ?? server.revision + 1); } catch { /* keep local only */ }
          }
        }
        window.dispatchEvent(new Event("dsh-needs-input-refresh"));
      }, 600);
    }

    /** Per-chat merge of two ack maps, newest wins per colour. */
    /** Host rows [{id,y,g,t}] -> {id: {y,g,t}}. */
    function rowsToMap(rows) {
      const out = {};
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row.id !== "string") continue;
        const cur = out[row.id] || { y: 0, g: 0, t: 0 };
        out[row.id] = {
          y: Math.max(cur.y, Number(row.y ?? 0)),
          g: Math.max(cur.g, Number(row.g ?? 0)),
          t: Math.max(cur.t, Number(row.t ?? 0)),
        };
      }
      return out;
    }

    /** {id: {y,g,t}} -> host rows, merging any rows this device did not touch. */
    function mapToRows(map, keep) {
      const merged = { ...rowsToMap(keep) };
      for (const [id, ack] of Object.entries(map || {})) merged[id] = { ...(merged[id] || {}), ...ack };
      return Object.entries(merged)
        .filter(([id]) => typeof id === "string" && id.length > 0)
        .map(([id, ack]) => ({ id, y: Number(ack.y ?? 0), g: Number(ack.g ?? 0), t: Number(ack.t ?? 0) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    function combineAckObjects(a, b) {
      const out = { ...a };
      for (const [id, ack] of Object.entries(b || {})) {
        const cur = out[id] || {};
        out[id] = {
          y: Math.max(Number(cur.y ?? 0), Number(ack?.y ?? 0)),
          g: Math.max(Number(cur.g ?? 0), Number(ack?.g ?? 0)),
          t: Math.max(Number(cur.t ?? 0), Number(ack?.t ?? 0)),
        };
      }
      return out;
    }
    // Scheduled tasks (owner request 2026-11-02): a chat with an ACTIVE scheduled task is not
    // finished yet — each run ends a turn, but the task is still pending. Such chats get no yellow or
    // green dot (the shipped schedule plugin's clock mark shows instead); the dots come back once the
    // task is no longer active, so the run that fulfils it still lights the chat up.
    const scheduled = { ids: new Set() };
    const uiSessionRef = { current: null }; // DSH's uiSession service (owner of the native "Completed" dot)

    /** Session ids that own at least one active scheduled task, from the host task catalog. */
    function activeScheduleSessions(records) {
      const ids = new Set();
      for (const r of Array.isArray(records) ? records : []) {
        if (r && r.status === "active" && typeof r.sessionId === "string") ids.add(r.sessionId);
      }
      return ids;
    }

    async function loadSchedules(remote) {
      if (!remote?.schedule?.catalog) return false;
      try {
        const res = await remote.schedule.catalog();
        if (res && res.ok === false) return false;
        const records = res && res.value !== undefined ? res.value : res;
        if (!Array.isArray(records)) return false;
        const next = activeScheduleSessions(records);
        const same = next.size === scheduled.ids.size && [...next].every((id) => scheduled.ids.has(id));
        scheduled.ids = next;
        return !same;
      } catch { return false; }
    }

    // ERROR (red) has NO read watermark on purpose: an error keeps its dot until the chat is proceeded
    // with a new message (owner rule 2026-11-03 — "don't remove red dot for chats with errors").
    function redUnread(state) { return Boolean(state && state.needsInput === "error"); }
    function yellowUnread(state, read) {
      return Boolean(state && state.needsInput !== "none" && state.needsInput !== "error" && state.needsInputSeq > read);
    }
    function greenUnread(state, read) { return Boolean(state && state.completedSeq > 0 && state.completedSeq > read); }

    // Read marks are per-browser (localStorage) and DSH's own `completionUnread` lives only in the
    // page's memory — so on a NEW browser, a cleared storage, another device, or the other origin
    // (127.0.0.1:3081 vs the public hostname) every chat that ever finished looked unread and the
    // whole workspace lit up (owner report 2026-10-27). Fix: when a session has no mark yet AND its
    // last activity predates this page load, record its current sequences as already read. A chat
    // that finishes while the page is open still has updatedAt >= pageLoadedAt, so it still lights up.
    // Pure so verify.mjs can exercise it against the shipped code.
    function seedMarks({ sessions, workspaces }, read, pageLoadedAt) {
      const next = { ...read };
      let changed = false;
      const ids = new Set();
      for (const id of Object.keys(sessions.byId || {})) ids.add(id);
      for (const w of workspaces.items || []) for (const id of w.sessionIds || []) ids.add(id);
      for (const id of ids) {
        if (next[id + ":y"] !== undefined || next[id + ":g"] !== undefined) continue;
        const st = sessions.projectionsBySession?.[id]?.values?.needsInput;
        if (!st) continue; // nothing folded yet: decide when it arrives
        if (st.needsInput === "error") continue; // red is sticky: a first visit must not swallow it
        const updated = sessions.byId?.[id]?.updatedAt;
        if (!(typeof updated === "number" && updated >= pageLoadedAt)) {
          next[id + ":y"] = Number(st.needsInputSeq ?? 0);
          next[id + ":g"] = Number(st.completedSeq ?? 0);
          changed = true;
        }
      }
      return changed ? next : null;
    }

    // Workspace rows: independent yellow and green aggregates over the members the sidebar would
    // list, including rows that are collapsed or paged out of the tree. A chat that cannot be
    // opened from that workspace never lights it: archived chats (owner rule 2026-10-27 — "if all
    // chats are archived there's nothing to view"), subagent children, and blank drafts other than
    // the current one (the same rule as the shipped sidebar's sessionVisible, default filter).
    function workspaceCounts({ sessions, workspaces, status }, read, main, scheduledIds) {
      const archived = new Set(workspaces.archivedSessionIds || []);
      const listed = (id) => {
        if (archived.has(id)) return false;
        if (scheduledIds?.has?.(id)) return false; // task still scheduled: not finished yet
        // A running chat is not finished: its row shows the native "running" dot and none of ours,
        // so the workspace must not count its previous completion either (owner report 2026-11-02:
        // the one active chat lit its whole workspace).
        if (status?.get?.(id)?.running) return false;

        const s = sessions.byId?.[id];
        if (s?.origin === "subagent") return false;
        if (s?.blank && id !== main) return false;
        return true;
      };
      const stateOf = (id) => sessions.projectionsBySession?.[id]?.values?.needsInput;
      const counts = new Map();
      for (const w of workspaces.items || []) {
        let red = 0, yellow = 0, green = 0;
        for (const id of w.sessionIds || []) {
          if (!listed(id)) continue;
          const st = stateOf(id);
          if (redUnread(st)) red++;
          else if (yellowUnread(st, Number(read[id + ":y"] ?? 0))) yellow++;
          else if (id !== main && (greenUnread(st, Number(read[id + ":g"] ?? 0)) || status?.get?.(id)?.completionUnread)) green++;
        }
        counts.set(w.workspaceId, { red, yellow, green });
      }
      return counts;
    }

    function dot(cls, label, color) {
      const node = document.createElement("span");
      node.className = "dsh-needs-input-dot " + cls;
      node.textContent = "\u25CF";
      node.title = label;
      node.setAttribute("role", "img");
      node.setAttribute("aria-label", label);
      node.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:20px;font-size:9px;line-height:1;color:" + color;
      return node;
    }
    function Indicators({ useSessions, useWorkspaces, useSessionStatus }) {
      const sessions = useSessions((s) => s);
      const workspaces = useWorkspaces((s) => s);
      const status = useSessionStatus((s) => s);
      const latest = React.useRef(null);
      latest.current = { sessions, workspaces, status };

      React.useEffect(() => {
        const paint = () => {
          const snap = latest.current;
          if (!snap) return;
          const { sessions, workspaces, status } = snap;
          let read = readMarks();
          const seeded = seedMarks(snap, read, PAGE_LOADED_AT);
          if (seeded) { read = seeded; writeMarks(seeded); }
          read = combineMarks(read, server.acks);
          const stateOf = (id) => sessions.projectionsBySession?.[id]?.values?.needsInput;
          const main = Object.values(sessions.byId || {}).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id;

          // Reading a chat in the main view is reading it: acknowledge continuously, not only on a
          // sidebar click (owner report 2026-10-28 — chats that were read still came back unread).
          if (main) {
            const st = stateOf(main);
            // An error is not acknowledgeable (red dot), so do not queue a write that would change nothing.
            if (st && st.needsInput !== "error" && (Number(st.needsInputSeq ?? 0) > Number(read[main + ":y"] ?? 0) || Number(st.completedSeq ?? 0) > Number(read[main + ":g"] ?? 0))) {
              const ack = ackFor(st, { y: read[main + ":y"], g: read[main + ":g"] });
              read[main + ":y"] = ack.y;
              read[main + ":g"] = ack.g;
              writeMarks({ ...readMarks(), [main + ":y"]: ack.y, [main + ":g"]: ack.g });
              server.acks = { ...server.acks, [main]: ack };
              queuePush();
            }
          }

          // A scheduled run that ends while the chat is not open makes DSH's own row show the
          // "Completed" dot, which also displaces the schedule clock mark. Drop that page-local
          // reminder for chats whose task is still active, so the row goes back to the clock.
          const ui = uiSessionRef.current;
          if (ui && typeof ui.completionUnread?.delete === "function" && typeof ui.publishStatus === "function") {
            let cleared = false;
            for (const id of scheduled.ids) if (ui.completionUnread.delete(id)) cleared = true;
            if (cleared) { try { ui.publishStatus(); } catch { /* status republishes on its next change */ } }
          }

          // Session rows: additive dots in the leading cell. The native dot (pending / running /
          // completionUnread) owns that cell while it is shown; we only add ours when it is idle.
          for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
            const id = row.getAttribute("data-row-key").slice("session:".length);
            const st = stateOf(id);
            const native = status.get(id);
            const nativeBusy = Boolean(native?.pendingInteraction || native?.running || native?.completionUnread);
            const pendingTask = scheduled.ids.has(id);
            // The red error dot outranks the other two and is not clearable by viewing.
            const showRed = !nativeBusy && redUnread(st);
            const showYellow = !nativeBusy && !pendingTask && !showRed && yellowUnread(st, Number(read[id + ":y"] ?? 0));
            const showGreen = !nativeBusy && !pendingTask && !showRed && !showYellow && id !== main && greenUnread(st, Number(read[id + ":g"] ?? 0));
            const cell = row.querySelector(':scope > span[class*="slot"]') || row;
            const r = cell.querySelector(".dsh-needs-input-session-r");
            const y = cell.querySelector(".dsh-needs-input-session-y");
            const g = cell.querySelector(".dsh-needs-input-session-g");
            if (showRed && !r) cell.appendChild(dot("dsh-needs-input-session-r", "The last turn failed with an error; it stays marked until you continue the chat", RED));
            if (!showRed && r) r.remove();
            if (showYellow && !y) cell.appendChild(dot("dsh-needs-input-session-y", st.needsInput === "failed" ? "Unread: the output token limit stopped the turn" : "Unread: the task is blocked and needs you", YELLOW));
            if (!showYellow && y) y.remove();
            if (showGreen && !g) cell.appendChild(dot("dsh-needs-input-session-g", "Unread: the task finished", GREEN));
            if (!showGreen && g) g.remove();
          }

          const counts = workspaceCounts(snap, read, main, scheduled.ids);
          for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
            const id = row.getAttribute("data-row-key").slice("workspace:".length);
            const c = counts.get(id) || { red: 0, yellow: 0, green: 0 };
            // projectRow is a flex ROW but projectText is a flex COLUMN, so a dot appended inside
            // projectText wraps under the name. Insert one fixed cell as a row sibling right
            // before the title block: same line, before the workspace name, visible on hover too.
            const text = row.querySelector(':scope > span[class*="projectText"]');
            let anchor = row.querySelector(":scope > .dsh-needs-input-ws");
            if (!c.red && !c.yellow && !c.green) { if (anchor) anchor.remove(); continue; }
            if (!anchor) {
              anchor = document.createElement("span");
              anchor.className = "dsh-needs-input-dot dsh-needs-input-ws";
              // Row gap 6px + title margin 4px, trimmed by 2px = 8px after the dot (half of the
              // first one-line version's ~16px).
              anchor.style.cssText = "display:inline-flex;align-items:center;flex:none;height:20px;gap:3px;margin-right:-2px";
              if (text) row.insertBefore(anchor, text); else row.appendChild(anchor);
            }
            const r = anchor.querySelector(".dsh-needs-input-ws-r");
            const y = anchor.querySelector(".dsh-needs-input-ws-y");
            const g = anchor.querySelector(".dsh-needs-input-ws-g");
            const tight = (node) => { node.style.width = "9px"; return node; };
            // Red (a chat in this workspace ended on an error) leads the row.
            if (c.red && !r) anchor.insertBefore(tight(dot("dsh-needs-input-ws-r", "", RED)), anchor.firstChild);
            if (!c.red && r) r.remove();
            if (c.yellow && !y) anchor.appendChild(tight(dot("dsh-needs-input-ws-y", "", YELLOW)));
            if (!c.yellow && y) y.remove();
            if (c.green && !g) anchor.appendChild(tight(dot("dsh-needs-input-ws-g", "", GREEN)));
            if (!c.green && g) g.remove();
            const rr = anchor.querySelector(".dsh-needs-input-ws-r");
            const yy = anchor.querySelector(".dsh-needs-input-ws-y");
            const gg = anchor.querySelector(".dsh-needs-input-ws-g");
            if (rr) { rr.title = c.red + " chat" + (c.red === 1 ? "" : "s") + " ended on an error (stays until continued)"; rr.setAttribute("aria-label", rr.title); }
            if (yy) { yy.title = c.yellow + " chat" + (c.yellow === 1 ? "" : "s") + " need your input"; yy.setAttribute("aria-label", yy.title); }
            if (gg) { gg.title = c.green + " finished chat" + (c.green === 1 ? "" : "s") + " unread"; gg.setAttribute("aria-label", gg.title); }
          }
        };

        // Opening a chat acknowledges it: both colours advance to the sequences known right now.
        const onClick = (event) => {
          const row = event.target?.closest?.('[data-row-key^="session:"]');
          if (!row) return;
          const id = row.getAttribute("data-row-key").slice("session:".length);
          const st = latest.current?.sessions.projectionsBySession?.[id]?.values?.needsInput;
          const read = combineMarks(readMarks(), server.acks);
          const ack = ackFor(st, { y: read[id + ":y"], g: read[id + ":g"] });
          writeMarks({ ...readMarks(), [id + ":y"]: ack.y, [id + ":g"]: ack.g });
          server.acks = { ...server.acks, [id]: ack };
          queuePush();
          paint();
        };

        paint();
        const observer = new MutationObserver(paint);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("click", onClick, true);
        window.addEventListener("storage", paint);
        window.addEventListener("dsh-needs-input-refresh", paint);
        return () => {
          observer.disconnect();
          document.removeEventListener("click", onClick, true);
          window.removeEventListener("storage", paint);
          window.removeEventListener("dsh-needs-input-refresh", paint);
          for (const el of document.querySelectorAll(".dsh-needs-input-dot")) el.remove();
        };
      }, []);

      // Repaint whenever any snapshot changes (the observer only sees DOM mutations).
      React.useEffect(() => { window.dispatchEvent(new Event("dsh-needs-input-refresh")); }, [sessions, workspaces, status]);
      return null;
    }

    function apply(ctx) {
      // Host-side read marks: load once, then re-read periodically and whenever the tab regains
      // focus, so an acknowledgement made on another device clears the dots here too.
      server.remote = ctx?.remote || null;
      uiSessionRef.current = ctx?.uiSession || null;
      // Active scheduled tasks: initial read, every host change, and the same periodic/focus refresh.
      const refreshSchedules = () => { loadSchedules(server.remote).then((changed) => { if (changed) window.dispatchEvent(new Event("dsh-needs-input-refresh")); }); };
      if (server.remote?.schedule?.catalog) {
        refreshSchedules();
        if (typeof server.remote.$on === "function" && ctx.effect) {
          ctx.effect(() => server.remote.$on("schedule/changed", refreshSchedules), "dsh-needs-input: schedule catalog");
        }
      }
      if (server.remote?.settings?.describe) {
        const refresh = () => { refreshSchedules(); loadServerAcks().then((ok) => { if (ok) window.dispatchEvent(new Event("dsh-needs-input-refresh")); }); };
        refresh();
        setInterval(refresh, 15000);
        if (typeof window !== "undefined" && window.addEventListener) {
          window.addEventListener("focus", refresh);
          document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
        }
      }
      // The main chat auto-acknowledges: when a chat is open in the main view, mark it read as it
      // finishes so a later refresh does not resurrect a dot for the chat the user was watching.
      const sessions = ctx.get ? ctx.get("sessions") : undefined;
      if (sessions?.list?.subscribe) {
        ctx.effect(() => sessions.list.subscribe(() => {
          const list = sessions.list.getSnapshot();
          const main = Object.values(list.byId || {}).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id;
          if (!main) return;
          const st = list.projectionsBySession?.[main]?.values?.needsInput;
          if (!st) return;
          const read = readMarks();
          // Same rule as ackFor: a red error chat keeps its mark, only a new message clears it.
          const y = st.needsInput === "error" ? Number(read[main + ":y"] ?? 0) : Math.max(Number(read[main + ":y"] ?? 0), Number(st.needsInputSeq ?? 0));
          const g = Math.max(Number(read[main + ":g"] ?? 0), Number(st.completedSeq ?? 0));
          if (read[main + ":y"] !== y || read[main + ":g"] !== g) writeMarks({ ...read, [main + ":y"]: y, [main + ":g"]: g });
        }), "dsh-needs-input: main-view acknowledgement");
      }
      // shell.overlay is a `list` seat (additive, always mounted at root, click-through) and
      // carries useSessions/useWorkspaces/useSessionStatus. NOT sidebar.workspaces: that is a
      // `single` seat and a second registration would shadow the shipped WorkspaceBrowser.
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-needs-input-indicators",
        order: 900,
      }, Indicators));
    }

    exports.name = "dsh-needs-input";
    // cordis throws "cannot get property \"remote\" without inject" on ANY undeclared ctx.* read (optional
    // chaining does not help), and the browser swallows it into fiber state "failed" (2026-10-28).
    exports.inject = ["slots", "sessions", "remote", "remote.settings", "remote.schedule", "uiSession"];   // cordis checks EVERY level of a ctx.* read: the parent service AND the nested path
    exports.apply = apply;
    exports.workspaceCounts = workspaceCounts; // exposed for verify.mjs
    exports.seedMarks = seedMarks;             // exposed for verify.mjs
    exports.activeScheduleSessions = activeScheduleSessions;
    exports.combineMarks = combineMarks;       // exposed for verify.mjs
    exports.combineAckObjects = combineAckObjects;
    exports.ackFor = ackFor;
    exports.pickNamespace = pickNamespace;
    exports.rowsToMap = rowsToMap;
    exports.mapToRows = mapToRows;
    return module.exports;
  },
});
