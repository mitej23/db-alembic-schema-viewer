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
  schema: () => fetchJSON('/api/schema'),
  migrations: () => fetchJSON('/api/migrations'),
  info: () => fetchJSON('/api/info'),
  migrationSource: (rev) => fetchJSON(`/api/migrations/${rev}/source`),
};

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
};

// ─── Theme ────────────────────────────────────────────────────────────────

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
    ranksep: 160,   // generous horizontal gap between ranks (was 90)
    nodesep: 80,    // generous vertical gap inside a rank (was 44)
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

// ─── Schema → React Flow nodes/edges ─────────────────────────────────────────

function buildGraph(schema, search = '') {
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

// ─── Column flag helper ──────────────────────────────────────────────────────

function colFlag(col, fkCols) {
  if (col.primary_key) return { cls: 'pk', label: 'PK', title: 'Primary key' };
  if (fkCols.has(col.name)) return { cls: 'fk', label: 'FK', title: 'Foreign key' };
  if (col.unique) return { cls: 'uq', label: 'UQ', title: 'Unique' };
  if (col.nullable) return { cls: 'nullable', label: 'N', title: 'Nullable' };
  return null;
}

// ─── TableNode ───────────────────────────────────────────────────────────────

const TableNode = memo(function TableNode({ data, selected }) {
  const t = data.table;
  const fkCols = useMemo(
    () => new Set(t.foreign_keys.map((fk) => fk.column)),
    [t.foreign_keys],
  );

  return html`
    <div class=${`table-node ${selected ? 'selected' : ''} ${data.dimmed ? 'dimmed' : ''}`}>
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

// ─── TopBar ──────────────────────────────────────────────────────────────────

function TopBar({ schema, info, migrationCount, onRefresh, onOpenMigrations, theme, setTheme }) {
  const sourceLabel = info?.source === 'database'
    ? info.database_url
    : (info?.models || '');

  return html`
    <header class="topbar">
      <div class="topbar-brand">
        <${Icon.database} size=${15}/>
        <span>schema-viewer</span>
      </div>
      <div class="topbar-meta">
        ${schema && html`
          <span class="pill" title="Tables in scope">
            <span class="dot"/>
            ${schema.tables.length} ${schema.tables.length === 1 ? 'table' : 'tables'}
          </span>
        `}
        ${sourceLabel && html`<span class="source-label" title=${sourceLabel}>${sourceLabel}</span>`}
        ${schema?.current_revision && html`
          <span class="pill muted" title="Current alembic_version in DB">
            head · ${schema.current_revision.slice(0, 12)}
          </span>
        `}
      </div>
      <div class="topbar-spacer"/>
      <div class="topbar-actions">
        ${migrationCount > 0 && html`
          <button class="btn" onClick=${onOpenMigrations} title="Open migration history">
            <${Icon.history} size=${14}/>
            <span>${migrationCount} ${migrationCount === 1 ? 'migration' : 'migrations'}</span>
          </button>
        `}
        <button class="icon-btn" onClick=${onRefresh} title="Reload schema" aria-label="Reload schema">
          <${Icon.refresh}/>
        </button>
        <${ThemeToggle} theme=${theme} setTheme=${setTheme}/>
      </div>
    </header>
  `;
}

// ─── Sidebar (with collapsible columns) ──────────────────────────────────────

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

// ─── Migrations sheet (right-side, drill-in for source) ──────────────────────

function MigrationsSheet({ open, migrations, currentRevision, onClose }) {
  const [detail, setDetail] = useState(null); // { revision, description, source, loading }

  // Reset detail when sheet closes
  useEffect(() => { if (!open) setDetail(null); }, [open]);

  // Esc closes — back to list first if in detail, else close sheet
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (detail) setDetail(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, detail, onClose]);

  const openDetail = useCallback(async (m) => {
    setDetail({ revision: m.revision, description: m.description, source: '', loading: true });
    try {
      const res = await api.migrationSource(m.revision);
      setDetail({ revision: m.revision, description: m.description, source: res.source, loading: false });
    } catch (e) {
      setDetail({
        revision: m.revision,
        description: m.description,
        source: `# Failed to load source\n# ${e.message}`,
        loading: false,
      });
    }
  }, []);

  if (!open) return null;

  return html`
    <div class="sheet-backdrop" onClick=${onClose}/>
    <aside class="sheet" role="dialog" aria-label="Migration history" onClick=${(e) => e.stopPropagation()}>
      ${detail
        ? html`
          <header class="sheet-header">
            <button class="icon-btn" onClick=${() => setDetail(null)} title="Back to list" aria-label="Back to list">
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
        `
        : html`
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
              const cls = ['migration', m.is_applied && 'applied', isCurrent && 'is-current']
                .filter(Boolean).join(' ');
              return html`
                <div
                  key=${m.revision}
                  class=${cls}
                  onClick=${() => openDetail(m)}
                  title="View source"
                >
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
                No Alembic migrations found.
              </div>
            `}
          </div>
        `}
    </aside>
  `;
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [theme, setTheme] = useTheme();
  const [schema, setSchema] = useState(null);
  const [migrations, setMigrations] = useState([]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [migrationsOpen, setMigrationsOpen] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const reactFlow = useReactFlow();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, m, i] = await Promise.all([
        api.schema(),
        api.migrations().catch(() => []),
        api.info().catch(() => null),
      ]);
      setSchema(s);
      setMigrations(m);
      setInfo(i);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Cmd/Ctrl+K → focus sidebar search
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

  // Build/layout the graph ONLY when schema or search changes.
  // Selection no longer triggers layout — it just updates highlight + centers.
  useEffect(() => {
    if (!schema) return;
    const { nodes: n, edges: e } = buildGraph(schema, search);
    setNodes(n);
    setEdges(e);
    // After re-layout, fit view to the new visible set
    const id = setTimeout(() => {
      try { reactFlow.fitView({ padding: 0.18, duration: 250, maxZoom: 1.0 }); } catch {}
    }, 30);
    return () => clearTimeout(id);
  }, [schema, search, setNodes, setEdges, reactFlow]);

  // Selection: highlight the node without rebuilding the graph.
  useEffect(() => {
    setNodes((current) =>
      current.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected })),
    );
  }, [selected, setNodes]);

  // Pan/zoom to the selected table.
  useEffect(() => {
    if (!selected) return;
    const id = setTimeout(() => {
      try {
        const node = reactFlow.getNode(selected);
        if (!node) return;
        const w = node.measured?.width ?? NODE_WIDTH;
        const h = node.measured?.height ?? node.data?.height ?? 100;
        reactFlow.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
          zoom: 1.0,
          duration: 350,
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
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((_, node) => {
    setSelected((cur) => (cur === node.id ? null : node.id));
  }, []);

  return html`
    <div class="app">
      <${TopBar}
        schema=${schema}
        info=${info}
        migrationCount=${migrations.length}
        onRefresh=${load}
        onOpenMigrations=${() => setMigrationsOpen(true)}
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
        <${ReactFlow}
          nodes=${nodes}
          edges=${edges}
          nodeTypes=${nodeTypes}
          colorMode=${theme}
          onNodesChange=${onNodesChange}
          onEdgesChange=${onEdgesChange}
          onNodeClick=${handleNodeClick}
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
        onClose=${() => setMigrationsOpen(false)}
      />
    </div>
  `;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById('root'));
root.render(html`<${ReactFlowProvider}><${App}/><//>`);
