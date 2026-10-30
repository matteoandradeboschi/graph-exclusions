const { Plugin, TextComponent, ToggleComponent, TFile, getAllTags, setIcon, debounce } = require("obsidian");

const DEFAULTS = { exclusions: [] };
const GRAPH_TYPES = ["graph", "localgraph"];

module.exports = class GraphExclusions extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.patched = new Set();
    this.saveAndRefresh = debounce(() => { this.saveData(this.settings); this.refresh(); }, 300, true);

    this.app.workspace.onLayoutReady(() => this.setupAll());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.setupAll()));
  }

  onunload() {
    for (const r of this.patched) {
      delete r.setData;
      if (r.setData !== r._geRestore) r.setData = r._geRestore;
      if (r._geOriginal) r.setData(r._geOriginal);
      delete r._geOriginal;
      delete r._geRestore;
    }
    document.querySelectorAll(".graph-exclusions").forEach((el) => el.remove());
  }

  graphViews() {
    return GRAPH_TYPES.flatMap((t) => this.app.workspace.getLeavesOfType(t)).map((l) => l.view);
  }

  setupAll() {
    for (const view of this.graphViews()) {
      this.patchRenderer(view);
      this.injectUI(view);
    }
  }

  // Intercepts the data the graph draws and removes excluded nodes (and their links).
  patchRenderer(view) {
    const r = view.renderer;
    if (!r || typeof r.setData !== "function") {
      console.warn("[graph-exclusions] Graph renderer not found; Obsidian internals may have changed.");
      return;
    }
    if (this.patched.has(r)) return;
    const orig = r.setData;
    r.setData = (data) => {
      r._geOriginal = data;
      return orig.call(r, this.filter(data));
    };
    r._geRestore = orig;
    this.patched.add(r);
    // force an already open graph to redraw through the filter
    const engine = view.dataEngine || view.engine;
    if (engine && typeof engine.render === "function") engine.render();
  }

  refresh() {
    for (const r of this.patched) if (r._geOriginal) r.setData(r._geOriginal);
  }

  filter(data) {
    const active = this.settings.exclusions.filter((e) => e.enabled && e.query.trim());
    if (!active.length || !data || !data.nodes) return data;

    const removed = new Set(Object.keys(data.nodes).filter((id) => active.some((e) => this.matches(id, e.query))));
    if (!removed.size) return data;

    const nodes = {};
    for (const [id, node] of Object.entries(data.nodes)) {
      if (removed.has(id)) continue;
      const links = {};
      for (const [target, v] of Object.entries(node.links || {})) if (!removed.has(target)) links[target] = v;
      nodes[id] = Object.assign({}, node, { links });
    }
    return Object.assign({}, data, { nodes });
  }

  // Supports path:, tag:, file: and plain text (searched in the path). A leading "-" is ignored.
  matches(id, rawQuery) {
    const q = rawQuery.trim().replace(/^-/, "");
    const i = q.indexOf(":");
    const key = i > 0 ? q.slice(0, i).toLowerCase() : "";
    const value = (i > 0 ? q.slice(i + 1) : q).trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    if (!value) return false;
    const path = id.toLowerCase();

    if (key === "path") return path.includes(value);
    if (key === "file") return path.split("/").pop().includes(value);
    if (key === "tag") {
      const tag = value.replace(/^#/, "");
      if (path === "#" + tag) return true; // tag node (when "Tags" is enabled)
      const file = this.app.vault.getAbstractFileByPath(id);
      if (!(file instanceof TFile)) return false;
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = (cache && getAllTags(cache)) || [];
      return tags.some((t) => {
        const n = t.replace(/^#/, "").toLowerCase();
        return n === tag || n.startsWith(tag + "/");
      });
    }
    return path.includes(value);
  }

  injectUI(view) {
    const controls = view.containerEl.querySelector(".graph-controls");
    if (!controls) return;
    const ensure = () => {
      const children = controls.querySelector(".mod-filter .tree-item-children");
      if (children && !children.querySelector(".graph-exclusions")) this.buildUI(children);
    };
    ensure();
    if (!view._geObserver) {
      view._geObserver = new MutationObserver(ensure);
      view._geObserver.observe(controls, { childList: true, subtree: true });
      this.register(() => view._geObserver.disconnect());
    }
  }

  buildUI(parent) {
    const box = parent.createDiv({ cls: "graph-exclusions" });
    box.createDiv({ cls: "graph-exclusions-title", text: "Exclusions" });
    const list = box.createDiv();

    const render = () => {
      // re-render every instance (global and local graph) so they stay in sync
      document.querySelectorAll(".graph-exclusions").forEach((el) => el._geRender && el._geRender());
    };

    box._geRender = () => {
      list.empty();
      this.settings.exclusions.forEach((ex, idx) => {
        const row = list.createDiv({ cls: "graph-exclusions-row" });
        const del = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Remove" } });
        setIcon(del, "x");
        del.onclick = () => { this.settings.exclusions.splice(idx, 1); this.saveAndRefresh(); render(); };

        new TextComponent(row)
          .setPlaceholder("path:folder or tag:#tag")
          .setValue(ex.query)
          .onChange((v) => { ex.query = v; this.saveAndRefresh(); });

        new ToggleComponent(row)
          .setValue(ex.enabled)
          .onChange((v) => { ex.enabled = v; this.saveAndRefresh(); });
      });
    };

    const btn = box.createEl("button", { cls: "graph-exclusions-add", text: "New exclusion" });
    btn.onclick = () => { this.settings.exclusions.push({ query: "", enabled: true }); this.saveData(this.settings); render(); };

    box._geRender();
  }
};
