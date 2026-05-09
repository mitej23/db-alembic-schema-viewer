import React, { useEffect, useState, useMemo, useCallback, memo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import htm from 'htm';

const html = htm.bind(React.createElement);

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

const api = {
  info:        () => fetchJSON('/api/info'),
  schema:      () => fetchJSON('/api/schema'),
  migrations:  () => fetchJSON('/api/migrations'),
  migrationSource: (rev) => fetchJSON(`/api/migrations/${rev}/source`),

  cacheProjects:        () => fetchJSON('/api/cache/projects'),
  cacheProjectEntries:  (pid) => fetchJSON(`/api/cache/projects/${pid}/entries`),
  cacheEntry:           (id) => fetchJSON(`/api/cache/entries/${id}`),
  cacheEntryMigSource:  (id, rev) => fetchJSON(`/api/cache/entries/${id}/source?revision=${encodeURIComponent(rev)}`),

  fsList:    (path, includeHidden = false) =>
    fetchJSON(`/api/fs/list?path=${encodeURIComponent(path)}&include_hidden=${includeHidden}`),
  fsDetect:  (path) => fetchJSON(`/api/fs/detect?path=${encodeURIComponent(path)}`),
  cacheFetch: (body) =>
    fetch('/api/cache/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail?.error || data.detail || JSON.stringify(data));
      return data;
    }),
};

// ─── Hash routing ────────────────────────────────────────────────────────────

function parseRoute(hash) {
  const h = (hash || '').replace(/^#/, '') || '/';
  if (h === '/' || h === '') return { name: 'dashboard' };
  if (h === '/live') return { name: 'live' };
  const m = h.match(/^\/entry\/(\d+)$/);
  if (m) return { name: 'entry', id: parseInt(m[1], 10) };
  return { name: 'dashboard' };
}

function navigate(path) {
  const target = '#' + (path.startsWith('/') ? path : '/' + path);
  if (window.location.hash !== target) window.location.hash = target;
}

function useHashRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// ─── Lucide icons ────────────────────────────────────────────────────────────

function LucideIcon({ children, size = 16, strokeWidth = 2, ...rest }) {
  return html`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width=${size}
      height=${size}
      fill="none"
      stroke="currentColor"
      stroke-width=${strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ...${rest}
    >${children}</svg>
  `;
}

const Icon = {
  table:        (p) => html`<${LucideIcon} ...${p}><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/><//>`,
  database:     (p) => html`<${LucideIcon} ...${p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/><//>`,
  search:       (p) => html`<${LucideIcon} ...${p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><//>`,
  history:      (p) => html`<${LucideIcon} ...${p}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/><//>`,
  refresh:      (p) => html`<${LucideIcon} ...${p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/><//>`,
  x:            (p) => html`<${LucideIcon} ...${p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/><//>`,
  sun:          (p) => html`<${LucideIcon} ...${p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/><//>`,
  moon:         (p) => html`<${LucideIcon} ...${p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><//>`,
  alert:        (p) => html`<${LucideIcon} ...${p}><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/><//>`,
  inspect:      (p) => html`<${LucideIcon} ...${p}><path d="M3 12a9 9 0 1 0 9-9"/><path d="M12 7v5l3 3"/><//>`,
  chevronRight: (p) => html`<${LucideIcon} ...${p}><path d="m9 18 6-6-6-6"/><//>`,
  chevronLeft:  (p) => html`<${LucideIcon} ...${p}><path d="m15 18-6-6 6-6"/><//>`,
  chevronDown:  (p) => html`<${LucideIcon} ...${p}><path d="m6 9 6 6 6-6"/><//>`,
  arrowLeft:    (p) => html`<${LucideIcon} ...${p}><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/><//>`,
  layers:       (p) => html`<${LucideIcon} ...${p}><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/><//>`,
  gitBranch:    (p) => html`<${LucideIcon} ...${p}><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/><//>`,
  folder:       (p) => html`<${LucideIcon} ...${p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><//>`,
  clock:        (p) => html`<${LucideIcon} ...${p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><//>`,
};

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEME_KEY = 'schema-viewer:theme';

function getInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useTheme() {
  const [theme, setTheme] = useState(getInitialTheme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => {
      try { if (localStorage.getItem(THEME_KEY)) return; } catch {}
      setTheme(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return [theme, setTheme];
}

function ThemeToggle({ theme, setTheme }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return html`
    <button class="icon-btn" onClick=${() => setTheme(next)}
            title=${`Switch to ${next} theme`} aria-label=${`Switch to ${next} theme`}>
      ${theme === 'dark' ? html`<${Icon.sun}/>` : html`<${Icon.moon}/>`}
    </button>
  `;
}

// ─── Time formatting ─────────────────────────────────────────────────────────

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const NODE_WIDTH = 280;
const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 26;

function tableNodeHeight(table) {
  return HEADER_HEIGHT + table.columns.length * ROW_HEIGHT + 1;
}

function layoutGraph(nodes, edges, direction = 'LR') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: 160,
    nodesep: 80,
    edgesep: 24,
    marginx: 32,
    marginy: 32,
    ranker: 'tight-tree',
  });
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: n.data.height }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - n.data.height / 2 },
    };
  });
}

function neighborsOf(schema, tableName) {
  const out = new Set([tableName]);
  schema.tables.forEach((t) => {
    if (t.name === tableName) {
      t.foreign_keys.forEach((fk) => out.add(fk.references_table));
    }
    t.foreign_keys.forEach((fk) => {
      if (fk.references_table === tableName) out.add(t.name);
    });
  });
  return out;
}

function buildGraph(schema, search = '') {
  // Build the full graph for current schema + search. Isolation is applied
  // on top of this via a separate mutation effect — no rebuild on focus.
  const term = search.trim().toLowerCase();
  const matched = new Set(
    schema.tables
      .filter((t) => !term || t.name.toLowerCase().includes(term))
      .map((t) => t.name),
  );
  const included = new Set(matched);
  if (term) {
    schema.tables.forEach((t) => {
      if (matched.has(t.name)) {
        t.foreign_keys.forEach((fk) => included.add(fk.references_table));
      }
    });
    schema.tables.forEach((t) => {
      t.foreign_keys.forEach((fk) => {
        if (matched.has(fk.references_table)) included.add(t.name);
      });
    });
  } else {
    schema.tables.forEach((t) => included.add(t.name));
  }

  const visible = schema.tables.filter((t) => included.has(t.name));
  const nodes = visible.map((t) => ({
    id: t.name,
    type: 'table',
    position: { x: 0, y: 0 },
    data: {
      table: t,
      height: tableNodeHeight(t),
      dimmed: term ? !matched.has(t.name) : false,
      focused: false,
    },
  }));

  const visibleSet = new Set(visible.map((t) => t.name));
  const edges = [];
  visible.forEach((t) => {
    t.foreign_keys.forEach((fk, idx) => {
      if (!visibleSet.has(fk.references_table)) return;
      edges.push({
        id: `${t.name}.${fk.column}->${fk.references_table}.${fk.references_column}#${idx}`,
        source: t.name,
        sourceHandle: `${fk.column}-source`,
        target: fk.references_table,
        targetHandle: `${fk.references_column}-target`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        type: 'smoothstep',
      });
    });
  });
  return { nodes: layoutGraph(nodes, edges), edges };
}

function colFlag(col, fkCols) {
  if (col.primary_key) return { cls: 'pk', label: 'PK', title: 'Primary key' };
  if (fkCols.has(col.name)) return { cls: 'fk', label: 'FK', title: 'Foreign key' };
  if (col.unique) return { cls: 'uq', label: 'UQ', title: 'Unique' };
  if (col.nullable) return { cls: 'nullable', label: 'N', title: 'Nullable' };
  return null;
}

const TableNode = memo(function TableNode({ data, selected }) {
  const t = data.table;
  const fkCols = useMemo(() => new Set(t.foreign_keys.map((fk) => fk.column)), [t.foreign_keys]);
  return html`
    <div class=${`table-node ${selected ? 'selected' : ''} ${data.dimmed ? 'dimmed' : ''} ${data.focused ? 'focused' : ''}`}>
      <div class="table-node-header">
        <${Icon.table} size=${13}/>
        <span class="table-name">${t.name}</span>
        ${t.schema && html`<span class="schema-name">${t.schema}</span>`}
      </div>
      ${t.columns.map((col) => {
        const flag = colFlag(col, fkCols);
        return html`
          <div class="table-node-row" key=${col.name}>
            <${Handle} type="target" position=${Position.Left}
              id=${`${col.name}-target`} isConnectable=${false} style=${{ top: '50%' }}/>
            ${flag
              ? html`<span class=${`col-flag ${flag.cls}`} title=${flag.title}>${flag.label}</span>`
              : html`<span aria-hidden="true"/>`}
            <span class=${`col-name ${col.nullable && !col.primary_key ? 'muted' : ''}`}>${col.name}</span>
            <span class="col-type">${col.type}</span>
            <${Handle} type="source" position=${Position.Right}
              id=${`${col.name}-source`} isConnectable=${false} style=${{ top: '50%' }}/>
          </div>
        `;
      })}
    </div>
  `;
});

const nodeTypes = { table: TableNode };

// ─── Sidebar (collapsible columns) ───────────────────────────────────────────

function ColumnRow({ col, fkCols }) {
  const flag = colFlag(col, fkCols);
  return html`
    <div class="sidebar-col">
      ${flag
        ? html`<span class=${`col-flag ${flag.cls}`} title=${flag.title}>${flag.label}</span>`
        : html`<span aria-hidden="true"/>`}
      <span class="sidebar-col-name">${col.name}</span>
      <span class="sidebar-col-type">${col.type}</span>
    </div>
  `;
}

function SidebarItem({ table, isActive, isExpanded, onSelect, onToggleExpand }) {
  const fkCols = useMemo(
    () => new Set(table.foreign_keys.map((fk) => fk.column)),
    [table.foreign_keys],
  );
  return html`
    <div class="sidebar-row-group">
      <div
        class=${`sidebar-item ${isActive ? 'active' : ''}`}
        onClick=${() => onSelect(table.name)}
      >
        <button
          class="sidebar-chevron"
          data-expanded=${isExpanded ? 'true' : 'false'}
          onClick=${(e) => { e.stopPropagation(); onToggleExpand(table.name); }}
          aria-label=${isExpanded ? 'Collapse columns' : 'Expand columns'}
          title=${isExpanded ? 'Collapse columns' : 'Expand columns'}
        >
          <${Icon.chevronRight} size=${11}/>
        </button>
        <span class="sidebar-item-icon"><${Icon.table} size=${13}/></span>
        <span class="label">${table.name}</span>
        <span class="count">${table.columns.length}</span>
      </div>
      ${isExpanded && html`
        <div class="sidebar-cols">
          ${table.columns.map((col) => html`<${ColumnRow} key=${col.name} col=${col} fkCols=${fkCols}/>`)}
        </div>
      `}
    </div>
  `;
}

function Sidebar({ schema, search, setSearch, selected, onSelect, expanded, onToggleExpand }) {
  const tables = schema?.tables || [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(term));
  }, [tables, search]);

  return html`
    <aside class="sidebar">
      <div class="sidebar-search">
        <${Icon.search} size=${13}/>
        <input
          type="search"
          placeholder="Search tables"
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
          spellcheck=${false}
        />
      </div>
      <div class="sidebar-section-label">
        <span>Tables</span>
        <span class="count-pill">${filtered.length}/${tables.length}</span>
      </div>
      <div class="sidebar-list" role="list">
        ${filtered.map((t) => html`
          <${SidebarItem}
            key=${t.name}
            table=${t}
            isActive=${selected === t.name}
            isExpanded=${expanded.has(t.name)}
            onSelect=${onSelect}
            onToggleExpand=${onToggleExpand}
          />
        `)}
        ${filtered.length === 0 && tables.length > 0 && html`
          <div class="sidebar-empty">No tables match <strong>${search}</strong>.</div>
        `}
        ${tables.length === 0 && html`
          <div class="sidebar-empty">No tables in this schema.</div>
        `}
      </div>
    </aside>
  `;
}

// ─── Migrations sheet ────────────────────────────────────────────────────────

function MigrationsSheet({ open, migrations, currentRevision, fetchSource, onClose }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { if (!open) setDetail(null); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (detail) setDetail(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, detail, onClose]);

  const openDetail = useCallback(async (m) => {
    setDetail({ revision: m.revision, description: m.description, source: '', loading: true });
    try {
      const res = await fetchSource(m.revision);
      setDetail({ revision: m.revision, description: m.description, source: res.source, loading: false });
    } catch (e) {
      setDetail({
        revision: m.revision,
        description: m.description,
        source: `# Failed to load source\n# ${e.message}`,
        loading: false,
      });
    }
  }, [fetchSource]);

  if (!open) return null;
  return html`
    <div class="sheet-backdrop" onClick=${onClose}/>
    <aside class="sheet" role="dialog" aria-label="Migration history" onClick=${(e) => e.stopPropagation()}>
      ${detail ? html`
        <header class="sheet-header">
          <button class="icon-btn" onClick=${() => setDetail(null)} title="Back" aria-label="Back">
            <${Icon.chevronLeft}/>
          </button>
          <div class="sheet-title-group">
            <span class="sheet-eyebrow">Migration${detail.description ? ' · ' + detail.description : ''}</span>
            <span class="sheet-title">${detail.revision}</span>
          </div>
          <button class="icon-btn" onClick=${onClose} title="Close" aria-label="Close">
            <${Icon.x}/>
          </button>
        </header>
        ${detail.loading
          ? html`<div class="sheet-loading">
              <div class="boot-spinner" style=${{ width: 14, height: 14, borderWidth: 1.5 }}/>
              Loading source…
            </div>`
          : html`<div class="sheet-body">${detail.source}</div>`}
      ` : html`
        <header class="sheet-header">
          <div class="sheet-title-group">
            <span class="sheet-eyebrow">Alembic</span>
            <span class="sheet-title-h">Migration history</span>
          </div>
          <span class="sheet-subtitle">
            ${migrations.length} ${migrations.length === 1 ? 'revision' : 'revisions'} · newest first
          </span>
          <div style=${{ flex: 1 }}/>
          <button class="icon-btn" onClick=${onClose} title="Close" aria-label="Close">
            <${Icon.x}/>
          </button>
        </header>
        <div class="sheet-list">
          ${migrations.map((m) => {
            const isCurrent = m.revision === currentRevision;
            const cls = ['migration', m.is_applied && 'applied', isCurrent && 'is-current'].filter(Boolean).join(' ');
            return html`
              <div key=${m.revision} class=${cls} onClick=${() => openDetail(m)} title="View source">
                <div class="migration-marker"/>
                <div class="migration-rev">${m.revision.slice(0, 12)}</div>
                <div class="migration-desc">${m.description || '(no description)'}</div>
                <div class="migration-tags">
                  ${m.is_current_head && html`<span class="tag head">head</span>`}
                  ${m.is_applied
                    ? html`<span class="tag applied">applied</span>`
                    : html`<span class="tag pending">pending</span>`}
                </div>
              </div>
            `;
          })}
          ${migrations.length === 0 && html`
            <div class="sidebar-empty" style=${{ padding: '40px 18px', textAlign: 'center' }}>
              No Alembic migrations available.
            </div>
          `}
        </div>
      `}
    </aside>
  `;
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

function TopBar({
  meta, info,
  schema, migrationCount,
  onRefresh, onOpenMigrations,
  onBackToDashboard,
  theme, setTheme,
}) {
  const live = meta?.kind === 'live';
  const cached = meta?.kind === 'cached';

  return html`
    <header class="topbar topbar-studio">
      <button
        class="icon-btn topbar-back"
        onClick=${onBackToDashboard}
        title="Back to dashboard"
        aria-label="Back to dashboard"
      >
        <${Icon.arrowLeft}/>
      </button>
      <a class="topbar-brand" href="#/" aria-label="Dashboard">
        <span class="topbar-brand-mark">
          <${Icon.database} size=${14}/>
        </span>
        <span class="topbar-brand-name">schema-viewer</span>
      </a>
      ${meta?.projectName && html`
        <span class="topbar-crumb-sep" aria-hidden="true">/</span>
        <span class="topbar-crumb">${meta.projectName}</span>
      `}
      <div class="topbar-pills">
        ${schema && html`
          <span class="pill" title="Tables in scope">
            <span class="dot"/>
            ${schema.tables.length} ${schema.tables.length === 1 ? 'table' : 'tables'}
          </span>
        `}
        ${cached && html`
          <span class="pill" title=${`Last fetched ${meta.fetchedAt}`}>
            <${Icon.clock} size=${10}/>
            cached · ${relTime(meta.fetchedAt)}
          </span>
        `}
        ${meta?.branch && html`
          <span class="pill muted" title="Git branch at fetch time">
            <${Icon.gitBranch} size=${10}/>
            ${meta.branch}
          </span>
        `}
        ${schema?.current_revision && html`
          <span class="pill muted" title="Current alembic_version">
            head · ${schema.current_revision.slice(0, 12)}
          </span>
        `}
      </div>
      <div class="topbar-spacer"/>
      <div class="topbar-actions">
        ${live && meta?.source?.target && html`
          <span class="source-label" title=${meta.source.target}>
            ${meta.source.target}
          </span>
        `}
        ${migrationCount > 0 && html`
          <button class="btn" onClick=${onOpenMigrations} title="Open migration history">
            <${Icon.history} size=${14}/>
            <span>${migrationCount} ${migrationCount === 1 ? 'migration' : 'migrations'}</span>
          </button>
        `}
        ${live && html`
          <button class="icon-btn" onClick=${onRefresh} title="Refetch (updates cache)" aria-label="Refetch">
            <${Icon.refresh}/>
          </button>
        `}
        <span class="topbar-divider" aria-hidden="true"/>
        <${ThemeToggle} theme=${theme} setTheme=${setTheme}/>
      </div>
    </header>
  `;
}

// ─── Studio (the diagram view, reused for live and cached) ───────────────────

function Studio({ mode, entryId, info, theme, setTheme }) {
  const [schema, setSchema] = useState(null);
  const [migrations, setMigrations] = useState([]);
  const [meta, setMeta] = useState(null); // { kind, source, branch, fetchedAt, projectName }
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [isolated, setIsolated] = useState(null); // double-tap focus
  const [expanded, setExpanded] = useState(() => new Set());
  const [migrationsOpen, setMigrationsOpen] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const reactFlow = useReactFlow();

  const fetchSource = useCallback((rev) => {
    if (mode === 'live') return api.migrationSource(rev);
    return api.cacheEntryMigSource(entryId, rev);
  }, [mode, entryId]);

  const load = useCallback(async () => {
    setError(null);
    setSchema(null);
    setMigrations([]);
    try {
      if (mode === 'live') {
        const [s, m] = await Promise.all([
          api.schema(),
          api.migrations().catch(() => []),
        ]);
        setSchema(s);
        setMigrations(m);
        setMeta({
          kind: 'live',
          source: info?.source,
          branch: info?.project?.branch,
          fetchedAt: null,
          projectName: info?.project?.name,
        });
      } else {
        const entry = await api.cacheEntry(entryId);
        setSchema(entry.schema);
        setMigrations(entry.migrations || []);
        setMeta({
          kind: 'cached',
          source: { type: entry.source_type, target: entry.source_target, env: entry.source_env },
          branch: entry.branch,
          fetchedAt: entry.fetched_at,
          projectName: entry.project?.name,
        });
      }
    } catch (e) {
      setError(e.message);
    }
  }, [mode, entryId, info]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector('.sidebar-search input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Build & layout — only when schema or search changes. Layout is expensive
  // and would shift node positions if re-run, so isolation mutates in-place
  // instead (next effect).
  useEffect(() => {
    if (!schema) return;
    const { nodes: n, edges: e } = buildGraph(schema, search);
    setNodes(n);
    setEdges(e);
    const id = setTimeout(() => {
      try { reactFlow.fitView({ padding: 0.18, duration: 250, maxZoom: 1.0 }); } catch {}
    }, 30);
    return () => clearTimeout(id);
  }, [schema, search, setNodes, setEdges, reactFlow]);

  // Isolation: patch dimmed/focused on existing nodes and add a class to
  // edges that don't touch the focused table. No rebuild, no fitView, no
  // dagre — positions are preserved exactly.
  useEffect(() => {
    if (!schema) return;
    const term = search.trim().toLowerCase();
    const searchMatched = term
      ? new Set(schema.tables.filter(t => t.name.toLowerCase().includes(term)).map(t => t.name))
      : null;

    if (isolated) {
      const neighbors = neighborsOf(schema, isolated);
      setNodes((cur) => cur.map((n) => ({
        ...n,
        data: {
          ...n.data,
          focused: n.id === isolated,
          dimmed: !neighbors.has(n.id),
        },
      })));
      setEdges((cur) => cur.map((e) => {
        const involves = e.source === isolated || e.target === isolated;
        return { ...e, className: involves ? '' : 'edge-faded' };
      }));
    } else {
      // Clear isolation: restore base dimming (search) and unfocus all.
      setNodes((cur) => cur.map((n) => ({
        ...n,
        data: {
          ...n.data,
          focused: false,
          dimmed: searchMatched ? !searchMatched.has(n.id) : false,
        },
      })));
      setEdges((cur) => cur.map((e) => ({ ...e, className: '' })));
    }
  }, [isolated, schema, search, setNodes, setEdges]);

  // Esc clears isolation.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && isolated) {
        setIsolated(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isolated]);

  useEffect(() => {
    setNodes((current) =>
      current.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected })),
    );
  }, [selected, setNodes]);

  useEffect(() => {
    if (!selected) return;
    const id = setTimeout(() => {
      try {
        const node = reactFlow.getNode(selected);
        if (!node) return;
        const w = node.measured?.width ?? NODE_WIDTH;
        const h = node.measured?.height ?? node.data?.height ?? 100;
        reactFlow.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
          zoom: 1.0, duration: 350,
        });
      } catch {}
    }, 30);
    return () => clearTimeout(id);
  }, [selected, reactFlow]);

  const handleSelectTable = useCallback((name) => {
    setSelected((cur) => (cur === name ? null : name));
  }, []);

  const handleToggleExpand = useCallback((name) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((_, node) => {
    setSelected((cur) => (cur === node.id ? null : node.id));
  }, []);

  const handleNodeDoubleClick = useCallback((_, node) => {
    setIsolated((cur) => (cur === node.id ? null : node.id));
  }, []);

  return html`
    <div class="app">
      <${TopBar}
        meta=${meta}
        info=${info}
        schema=${schema}
        migrationCount=${migrations.length}
        onRefresh=${load}
        onOpenMigrations=${() => setMigrationsOpen(true)}
        onBackToDashboard=${() => navigate('/')}
        theme=${theme}
        setTheme=${setTheme}
      />
      <${Sidebar}
        schema=${schema}
        search=${search}
        setSearch=${setSearch}
        selected=${selected}
        onSelect=${handleSelectTable}
        expanded=${expanded}
        onToggleExpand=${handleToggleExpand}
      />
      <div class="canvas">
        ${error && html`
          <div class="status-banner" role="alert">
            <${Icon.alert}/>
            <span>${error}</span>
          </div>
        `}
        ${isolated && html`
          <div class="focus-banner" role="status">
            <${Icon.inspect} size=${13}/>
            <span>Focused on <strong>${isolated}</strong> · showing direct connections only</span>
            <button class="btn btn-ghost btn-tiny" onClick=${() => setIsolated(null)}>
              Clear (Esc)
            </button>
          </div>
        `}
        ${schema && schema.tables.length === 0 && html`
          <div class="canvas-empty">
            <${Icon.inspect} size=${22}/>
            <div class="title">No tables to draw</div>
            <div class="body">
              The schema is empty. Double-check your <code class="kbd">--models</code> target
              or that your live database has tables in the expected schema.
            </div>
          </div>
        `}
        ${!schema && !error && html`
          <div class="canvas-empty">
            <div class="boot-spinner"/>
            <div class="body">Loading schema…</div>
          </div>
        `}
        <${ReactFlow}
          nodes=${nodes}
          edges=${edges}
          nodeTypes=${nodeTypes}
          colorMode=${theme}
          onNodesChange=${onNodesChange}
          onEdgesChange=${onEdgesChange}
          onNodeClick=${handleNodeClick}
          onNodeDoubleClick=${handleNodeDoubleClick}
          onPaneClick=${() => setSelected(null)}
          minZoom=${0.1}
          maxZoom=${2}
          proOptions=${{ hideAttribution: true }}
          defaultEdgeOptions=${{ type: 'smoothstep' }}
        >
          <${Background} gap=${24} size=${1}/>
          <${Controls} showInteractive=${false} position="bottom-right"/>
          <${MiniMap} pannable zoomable position="bottom-left" nodeStrokeWidth=${0}/>
        <//>
      </div>
      <${MigrationsSheet}
        open=${migrationsOpen}
        migrations=${migrations}
        currentRevision=${schema?.current_revision}
        fetchSource=${fetchSource}
        onClose=${() => setMigrationsOpen(false)}
      />
    </div>
  `;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function LaneBadge({ type, env }) {
  const cls = type === 'database' ? 'lane-db' : 'lane-models';
  return html`<span class=${`lane-badge ${cls}`}>
    ${type === 'database' ? html`<${Icon.database} size=${10}/>` : html`<${Icon.layers} size=${10}/>`}
    <span>${type}${env ? ` · ${env}` : ''}</span>
  </span>`;
}

function ProjectCard({ project, onOpenEntry }) {
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.cacheProjectEntries(project.id)
      .then((es) => { if (!cancelled) setEntries(es); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [project.id]);

  return html`
    <article class="project-card">
      <header class="project-card-header">
        <div class="project-card-titleblock">
          <h2 class="project-card-name">${project.name}</h2>
          <span class="project-card-path" title=${project.path}>${project.path}</span>
        </div>
      </header>
      <div class="project-card-entries">
        ${entries === null
          ? html`<div class="entry-row entry-row-skeleton" aria-hidden="true">
              <div class="skel skel-badge"/>
              <div class="skel skel-line"/>
              <div class="skel skel-pill"/>
            </div>`
          : entries.length === 0
          ? html`<div class="entries-empty">No snapshots yet for this project.</div>`
          : entries.map((e) => html`
              <button
                key=${e.id}
                class="entry-row"
                onClick=${() => onOpenEntry(project.id, e.id)}
                title=${`Open snapshot @${e.id} · ${e.source_target}`}
              >
                <${LaneBadge} type=${e.source_type} env=${e.source_env}/>
                <span class="entry-branch">
                  ${e.branch
                    ? html`<${Icon.gitBranch} size=${11}/><span>${e.branch}</span>`
                    : html`<span class="muted">no branch</span>`}
                </span>
                <span class="entry-target" title=${e.source_target}>${e.source_target}</span>
                <span class="entry-tables">
                  <strong>${e.table_count}</strong>
                  <span>${e.table_count === 1 ? 'table' : 'tables'}</span>
                </span>
                <span class="entry-time" title=${e.fetched_at}>${relTime(e.fetched_at)}</span>
                <span class="entry-arrow"><${Icon.chevronRight} size=${13}/></span>
              </button>
            `)}
      </div>
    </article>
  `;
}

// ─── Add-project sheet ──────────────────────────────────────────────────────

function relPathToModule(rootPath, selectedPath) {
  if (!rootPath || !selectedPath) return '';
  const root = rootPath.replace(/\/+$/, '');
  const sel = selectedPath.replace(/\/+$/, '');
  if (sel === root) return '';
  if (!sel.startsWith(root + '/')) return '';
  return sel.slice(root.length + 1).split('/').filter(Boolean).join('.');
}

function FolderBrowser({
  initialPath,
  rootConstraint,
  showShortcuts = true,
  onSelect,
  selectButtonLabel = 'Use this folder',
}) {
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [path, setPath] = useState(initialPath || rootConstraint || '~');

  const load = useCallback((p) => {
    setError(null);
    api.fsList(p)
      .then((res) => { setListing(res); setPath(res.path); })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(initialPath || rootConstraint || '~'); /* eslint-disable-line */ }, [initialPath, rootConstraint]);

  const constrainedParent = useMemo(() => {
    if (!listing?.parent) return null;
    if (rootConstraint && !listing.parent.startsWith(rootConstraint)) return null;
    return listing.parent;
  }, [listing, rootConstraint]);

  const isAtRoot = rootConstraint && path === rootConstraint;

  return html`
    <div class="folder-browser">
      <div class="folder-browser-bar">
        <button
          class="icon-btn"
          onClick=${() => constrainedParent && load(constrainedParent)}
          disabled=${!constrainedParent}
          title="Up one level"
          aria-label="Up one level"
        >
          <${Icon.chevronLeft}/>
        </button>
        <input
          class="folder-path"
          value=${path}
          onInput=${(e) => setPath(e.target.value)}
          onKeyDown=${(e) => e.key === 'Enter' && load(path)}
          spellcheck=${false}
        />
      </div>
      ${showShortcuts && html`
        <div class="folder-shortcuts">
          ${[
            { label: 'Home', path: listing?.home || '~' },
            { label: 'Desktop', path: (listing?.home || '~') + '/Desktop' },
            { label: 'Projects', path: (listing?.home || '~') + '/Projects' },
          ].map((s) => html`
            <button key=${s.label} class="chip" onClick=${() => load(s.path)}>${s.label}</button>
          `)}
        </div>
      `}
      ${error
        ? html`<div class="folder-error">${error}</div>`
        : !listing
        ? html`<div class="folder-loading"><div class="boot-spinner" style=${{width:14,height:14,borderWidth:1.5}}/>Loading</div>`
        : html`
          <div class="folder-list">
            ${listing.entries.length === 0
              ? html`<div class="folder-empty">${isAtRoot ? 'No subdirectories — use the root.' : 'Empty directory.'}</div>`
              : listing.entries.map((e) => html`
                  <div
                    key=${e.path}
                    class="folder-row"
                    onClick=${() => load(e.path)}
                    onDblClick=${() => onSelect(e.path)}
                    title="Click to open · double-click to select"
                  >
                    <${Icon.folder} size=${13}/>
                    <span class="folder-name">${e.name}</span>
                    <span class="folder-flags">
                      ${e.has_alembic_ini && html`<span class="flag-chip" title="alembic.ini">alembic</span>`}
                      ${e.has_pyproject && html`<span class="flag-chip" title="pyproject.toml / setup.py">python</span>`}
                      ${e.has_git && html`<span class="flag-chip muted" title=".git">git</span>`}
                    </span>
                  </div>
                `)}
          </div>
        `}
      <div class="folder-browser-foot">
        <span class="folder-foot-label">
          Selected: <code>${path}</code>
        </span>
        <button class="btn btn-primary" onClick=${() => onSelect(path)} disabled=${!path}>
          ${selectButtonLabel}
        </button>
      </div>
    </div>
  `;
}

function AddProjectSheet({ open, onClose, onCreated }) {
  const [step, setStep] = useState('folder'); // 'folder' | 'configure'
  const [projectPath, setProjectPath] = useState(null);
  const [detection, setDetection] = useState(null);
  const [sourceType, setSourceType] = useState('models');
  // For models: store both the picked subfolder path and the computed module
  const [schemaFolder, setSchemaFolder] = useState(null);
  const [modelsTargetOverride, setModelsTargetOverride] = useState('');
  const [dbUrl, setDbUrl] = useState('');
  const [envLabel, setEnvLabel] = useState('');
  const [alembicIni, setAlembicIni] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) return;
    setStep('folder');
    setProjectPath(null);
    setDetection(null);
    setSchemaFolder(null);
    setModelsTargetOverride('');
    setDbUrl('');
    setEnvLabel('');
    setAlembicIni('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  const onPickProjectFolder = useCallback(async (path) => {
    setProjectPath(path);
    setStep('configure');
    setError(null);
    try {
      const det = await api.fsDetect(path);
      setDetection(det);
      if (det.alembic_ini) setAlembicIni(det.alembic_ini);
      if (det.candidate_models?.length) {
        const top = det.candidate_models[0];
        setSchemaFolder(top.path);
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // Resolve the actual module string we'll send.
  const resolvedModelsTarget = modelsTargetOverride
    || (projectPath && schemaFolder ? relPathToModule(projectPath, schemaFolder) : '');

  const onSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        project_path: projectPath,
        source_type: sourceType,
        source_target: sourceType === 'models' ? resolvedModelsTarget : dbUrl,
        source_env: envLabel || null,
        alembic_ini: alembicIni || null,
      };
      const res = await api.cacheFetch(body);
      onCreated(res.entry_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }, [projectPath, sourceType, resolvedModelsTarget, dbUrl, envLabel, alembicIni, onCreated]);

  if (!open) return null;

  const canSubmit = sourceType === 'models'
    ? !!resolvedModelsTarget
    : !!dbUrl;

  return html`
    <div class="sheet-backdrop" onClick=${() => !submitting && onClose()}/>
    <aside class="sheet sheet-wide" role="dialog" aria-label="Add project" onClick=${(e) => e.stopPropagation()}>
      <header class="sheet-header">
        ${step === 'configure' && html`
          <button class="icon-btn" onClick=${() => setStep('folder')} title="Back" aria-label="Back">
            <${Icon.chevronLeft}/>
          </button>
        `}
        <div class="sheet-title-group">
          <span class="sheet-eyebrow">Step ${step === 'folder' ? '1' : '2'} of 2</span>
          <span class="sheet-title-h">${step === 'folder' ? 'Pick a project' : 'Choose what to fetch'}</span>
        </div>
        <div style=${{ flex: 1 }}/>
        <button class="icon-btn" onClick=${onClose} title="Close" aria-label="Close" disabled=${submitting}>
          <${Icon.x}/>
        </button>
      </header>
      <div class="sheet-form">
        ${step === 'folder' ? html`
          <p class="sheet-desc">
            Browse to your SQLAlchemy project's root. We'll auto-detect
            <code class="kbd">alembic.ini</code>, <code class="kbd">pyproject.toml</code>, and the
            most likely model package.
          </p>
          <${FolderBrowser}
            initialPath=${projectPath}
            onSelect=${onPickProjectFolder}
            selectButtonLabel="Use this folder as project root"
          />
        ` : html`
          <div class="form-summary">
            <div class="form-summary-row">
              <span class="form-summary-label">Project</span>
              <code class="form-summary-value" title=${projectPath}>${projectPath}</code>
              <button class="btn btn-ghost btn-tiny" onClick=${() => setStep('folder')}>Change</button>
            </div>
            ${detection && html`
              <div class="form-summary-row">
                <span class="form-summary-label">Detected</span>
                <div class="detect-pills">
                  <span class=${`detect-pill ${detection.alembic_ini ? 'on' : 'off'}`}>
                    ${detection.alembic_ini ? '✓ alembic.ini' : '— no alembic.ini'}
                  </span>
                  <span class=${`detect-pill ${detection.has_git ? 'on' : 'off'}`}>
                    ${detection.has_git ? '✓ git' : '— not in git'}
                  </span>
                  <span class=${`detect-pill ${detection.has_env ? 'on' : 'off'}`}>
                    ${detection.has_env ? '✓ .env' : '— no .env'}
                  </span>
                </div>
              </div>
            `}
          </div>

          <div class="form-section">
            <span class="form-section-label">Source</span>
            <div class="segmented">
              <button
                class=${sourceType === 'models' ? 'active' : ''}
                onClick=${() => setSourceType('models')}
              >
                <${Icon.layers} size=${12}/>
                Models (code)
              </button>
              <button
                class=${sourceType === 'database' ? 'active' : ''}
                onClick=${() => setSourceType('database')}
              >
                <${Icon.database} size=${12}/>
                Database (live)
              </button>
            </div>
          </div>

          ${sourceType === 'models' ? html`
            <div class="form-section">
              <div class="form-section-head">
                <span class="form-section-label">Schema folder</span>
                <span class="form-hint">Pick the package that contains your SQLAlchemy models.</span>
              </div>
              <${FolderBrowser}
                initialPath=${schemaFolder || projectPath}
                rootConstraint=${projectPath}
                showShortcuts=${false}
                onSelect=${(p) => { setSchemaFolder(p); setModelsTargetOverride(''); }}
                selectButtonLabel="Use this as the schema folder"
              />
              ${detection?.candidate_models?.length > 0 && html`
                <div class="form-suggestions">
                  <span class="form-hint">Suggested:</span>
                  ${detection.candidate_models.slice(0, 4).map((c) => html`
                    <button
                      key=${c.module}
                      class="chip"
                      data-active=${schemaFolder === c.path}
                      onClick=${() => { setSchemaFolder(c.path); setModelsTargetOverride(''); }}
                    >
                      ${c.module}
                    </button>
                  `)}
                </div>
              `}
              <div class="form-preview">
                <span class="form-preview-label">Will run</span>
                <code class="form-preview-value">
                  schema-viewer fetch --models <strong>${resolvedModelsTarget || '(pick a folder)'}</strong>
                </code>
              </div>
              <details class="form-advanced">
                <summary>Type the module path manually</summary>
                <input
                  class="form-input"
                  placeholder="app.db.schema  or  app.db.models:Base"
                  value=${modelsTargetOverride}
                  onInput=${(e) => setModelsTargetOverride(e.target.value)}
                  spellcheck=${false}
                />
              </details>
            </div>
          ` : html`
            <div class="form-section">
              <label class="form-section-label" for="db-url">Connection URL</label>
              <input
                id="db-url"
                class="form-input"
                placeholder="postgresql://user:pass@host:5432/db"
                value=${dbUrl}
                onInput=${(e) => setDbUrl(e.target.value)}
                spellcheck=${false}
              />
              <p class="form-hint">Async drivers (asyncpg, aiomysql, aiosqlite) are normalized to sync automatically.</p>
            </div>
            <div class="form-section">
              <label class="form-section-label" for="env-label">Environment label
                <span class="form-hint">— optional</span>
              </label>
              <input
                id="env-label"
                class="form-input"
                placeholder="prod, staging, local…"
                value=${envLabel}
                onInput=${(e) => setEnvLabel(e.target.value)}
                spellcheck=${false}
              />
              <p class="form-hint">Useful when the same project caches multiple databases.</p>
            </div>
          `}

          <div class="form-section">
            <label class="form-section-label" for="alembic-ini">
              alembic.ini path
              <span class="form-hint">— optional, auto-detected if at project root</span>
            </label>
            <input
              id="alembic-ini"
              class="form-input"
              placeholder=${detection?.alembic_ini || '/path/to/alembic.ini'}
              value=${alembicIni}
              onInput=${(e) => setAlembicIni(e.target.value)}
              spellcheck=${false}
            />
          </div>

          ${error && html`
            <div class="form-error">
              <${Icon.alert} size=${13}/>
              <span>${error}</span>
            </div>
          `}

          <div class="form-actions">
            <button class="btn btn-ghost" onClick=${onClose} disabled=${submitting}>Cancel</button>
            <button
              class="btn btn-primary"
              onClick=${onSubmit}
              disabled=${submitting || !canSubmit}
            >
              ${submitting
                ? html`<div class="boot-spinner" style=${{width:12,height:12,borderWidth:1.5,marginRight:6}}/>Fetching…`
                : 'Fetch & open'}
            </button>
          </div>
        `}
      </div>
    </aside>
  `;
}

function Dashboard({ info, theme, setTheme }) {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api.cacheProjects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEntry = useCallback((projectId, entryId) => {
    if (entryId) navigate(`/entry/${entryId}`);
  }, []);

  const onCreated = useCallback((entryId) => {
    setAddOpen(false);
    navigate(`/entry/${entryId}`);
  }, []);

  const visible = useMemo(() => {
    if (!projects) return projects;
    const term = filter.trim().toLowerCase();
    let list = projects.filter(p => p.entry_count > 0);
    if (term) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(term) || p.path.toLowerCase().includes(term)
      );
    }
    return list;
  }, [projects, filter]);

  return html`
    <div class="dashboard">
      <header class="topbar topbar-dashboard">
        <a class="topbar-brand topbar-brand-link" href="#/" aria-label="schema-viewer home">
          <span class="topbar-brand-mark">
            <${Icon.database} size=${14}/>
          </span>
          <span class="topbar-brand-name">schema-viewer</span>
        </a>
        <div class="topbar-spacer"/>
        <div class="topbar-actions">
          <button class="btn btn-primary" onClick=${() => setAddOpen(true)} title="Add a new project (browse + fetch)">
            <span class="btn-plus">+</span>
            <span>Add project</span>
          </button>
          <span class="topbar-divider" aria-hidden="true"/>
          <button class="icon-btn" onClick=${load} title="Reload cache" aria-label="Reload cache">
            <${Icon.refresh}/>
          </button>
          <${ThemeToggle} theme=${theme} setTheme=${setTheme}/>
        </div>
      </header>
      <main class="dashboard-main">
        <div class="dashboard-header">
          <div>
            <h1>Your projects</h1>
            <p class="dashboard-subtitle">
              ${projects && projects.filter(p => p.entry_count > 0).length > 0
                ? html`Click any snapshot to open it. Re-fetch from the project to refresh.`
                : html`Add a project to fetch its schema, then come back here to browse.`}
            </p>
          </div>
          ${projects && projects.filter(p => p.entry_count > 0).length > 2 && html`
            <div class="dashboard-filter">
              <${Icon.search} size=${13}/>
              <input
                type="search"
                placeholder="Filter projects"
                value=${filter}
                onInput=${(e) => setFilter(e.target.value)}
                spellcheck=${false}
              />
            </div>
          `}
        </div>
        ${error && html`
          <div class="status-banner status-banner-inline">
            <${Icon.alert} size=${14}/>
            <span>${error}</span>
          </div>
        `}
        ${projects === null
          ? html`<div class="dashboard-loading">
              <div class="boot-spinner"/>
              <span>Loading cache</span>
            </div>`
          : visible && visible.length === 0 && filter
          ? html`<div class="dashboard-empty-filter">No projects match <strong>${filter}</strong>.</div>`
          : visible && visible.length === 0
          ? html`<${EmptyDashboard} onAdd=${() => setAddOpen(true)}/>`
          : html`
            <div class="project-list">
              ${visible.map((p) => html`
                <${ProjectCard}
                  key=${p.id}
                  project=${p}
                  onOpenEntry=${openEntry}
                />
              `)}
            </div>
          `}
      </main>
      <${AddProjectSheet}
        open=${addOpen}
        onClose=${() => setAddOpen(false)}
        onCreated=${onCreated}
      />
    </div>
  `;
}

function EmptyDashboard({ onAdd }) {
  return html`
    <div class="dashboard-empty">
      <div class="dashboard-empty-icon">
        <${Icon.inspect} size=${24}/>
      </div>
      <div class="title">Nothing cached yet</div>
      <div class="body">
        Add your first project — pick a folder and we'll fetch the schema for you.
      </div>
      <button class="btn btn-primary btn-lg" onClick=${onAdd}>
        <span style=${{ fontSize: 14, lineHeight: 1, marginRight: 4 }}>+</span>
        Add a project
      </button>
      <p class="dashboard-empty-tip">
        Or run <code>schema-viewer studio --models app.db.schema</code> in a project terminal.
      </p>
    </div>
  `;
}

// ─── Top-level App with routing ──────────────────────────────────────────────

function App() {
  const [theme, setTheme] = useTheme();
  const [info, setInfo] = useState(null);
  const [bootError, setBootError] = useState(null);
  const route = useHashRoute();

  useEffect(() => {
    api.info().then(setInfo).catch((e) => setBootError(e.message));
  }, []);

  // Initial route: studio mode → /live; dashboard mode → /
  useEffect(() => {
    if (!info) return;
    const current = parseRoute(window.location.hash);
    if (current.name === 'dashboard' && info.mode === 'studio' && !window.location.hash) {
      navigate('/live');
    }
  }, [info]);

  if (bootError) {
    return html`
      <div class="boot">
        <div style=${{ color: 'var(--destructive)', textAlign: 'center', maxWidth: 480, padding: 24 }}>
          <strong>Failed to talk to the schema-viewer server.</strong>
          <p style=${{ color: 'var(--muted-foreground)', marginTop: 8 }}>${bootError}</p>
        </div>
      </div>
    `;
  }
  if (!info) {
    return html`
      <div class="boot">
        <div class="boot-spinner"/>
        <div class="boot-text">Connecting…</div>
      </div>
    `;
  }

  // Route → view
  if (route.name === 'entry') {
    return html`<${Studio} mode="cached" entryId=${route.id} info=${info} theme=${theme} setTheme=${setTheme}/>`;
  }
  if (route.name === 'live') {
    if (info.mode !== 'studio') {
      navigate('/');
      return null;
    }
    return html`<${Studio} mode="live" info=${info} theme=${theme} setTheme=${setTheme}/>`;
  }
  return html`<${Dashboard} info=${info} theme=${theme} setTheme=${setTheme}/>`;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById('root'));
root.render(html`<${ReactFlowProvider}><${App}/><//>`);
