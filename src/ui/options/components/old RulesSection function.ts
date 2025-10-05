function RulesSection({ tags, groups, collections }: { tags: TagRec[]; groups: GroupRec[]; collections: CollectionRec[] }) {
  const [rules, setRules] = React.useState<RuleRec[]>([]);
  const [creating, setCreating] = React.useState<{ name: string; groupId: string; add: string[]; remove: string[]; channelsText: string; enabled: boolean; actionKind: 'tags'|'collections'; recursive?: boolean }>({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false });
  const [editingRuleId, setEditingRuleId] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    try { const r: any = await sendBg('rules/list', {} as any); setRules(Array.isArray(r?.items) ? r.items as RuleRec[] : []); } catch { setRules([]); }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const h = (msg: any) => { if (msg?.type === 'db/change' && msg?.payload?.entity === 'rules') load(); };
    chrome.runtime.onMessage.addListener(h);
    return () => chrome.runtime.onMessage.removeListener(h);
  }, [load]);
  const allTagNames = React.useMemo(() => (tags || []).map(t => String(t.name)).filter(Boolean), [tags]);
  const allCollections = React.useMemo(() => (collections || []).map(c => ({ id: c.id, name: c.name })), [collections]);
  function addTo(list: 'add'|'remove', name: string) {
    if (!name) return;
    setCreating(prev => ({ ...prev, [list]: Array.from(new Set([...(prev as any)[list], name])) } as any));
  }
  function removeFrom(list: 'add'|'remove', name: string) {
    setCreating(prev => ({ ...prev, [list]: (prev as any)[list].filter((t: string) => t !== name) } as any));
  }
  async function onCreate() {
    const name = creating.name.trim();
    const groupId = creating.groupId.trim();
    if (!name || !groupId) return;
    const channelIds = creating.channelsText.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    const action = creating.actionKind === 'collections'
      ? ({ kind: 'collections', add: creating.add, remove: creating.remove, recursive: !!creating.recursive } as const)
      : ({ kind: 'tags', add: creating.add, remove: creating.remove } as const);
    const r: any = await sendBg('rules/create', { name, groupId, action, channelIds, enabled: creating.enabled } as any);
    if (r?.ok) {
      setCreating({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true });
      load();
    }
  }
  function startEditRule(rule: RuleRec) {
    const actionKind: 'tags'|'collections' = (rule.action?.kind === 'collections') ? 'collections' : 'tags';
    const add = Array.isArray((rule.action as any)?.add) ? ((rule.action as any).add as string[]) : [];
    const remove = Array.isArray((rule.action as any)?.remove) ? ((rule.action as any).remove as string[]) : [];
    const channelsText = Array.isArray(rule.channelIds) ? rule.channelIds.join(' ') : '';
    setCreating({
      name: rule.name || '',
      groupId: String(rule.groupId || ''),
      add: add.slice(),
      remove: remove.slice(),
      channelsText,
      enabled: rule.enabled !== false,
      actionKind,
      recursive: actionKind === 'collections' ? !!(rule.action as any)?.recursive : false,
    });
    setEditingRuleId(rule.id);
  }
  async function onSaveEdit() {
    if (!editingRuleId) return;
    const name = creating.name.trim();
    const groupId = creating.groupId.trim();
    if (!name || !groupId) return;
    const channelIds = creating.channelsText.split(/[\,\s]+/).map(s => s.trim()).filter(Boolean);
    const action = creating.actionKind === 'collections'
      ? ({ kind: 'collections', add: creating.add, remove: creating.remove, recursive: !!creating.recursive } as const)
      : ({ kind: 'tags', add: creating.add, remove: creating.remove } as const);
    await sendBg('rules/update', { id: editingRuleId, patch: { name, groupId, action, channelIds, enabled: creating.enabled } } as any);
    setEditingRuleId(null);
    setCreating({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false });
  }
  function onCancelEdit() {
    setEditingRuleId(null);
    setCreating({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false });
  }
  async function onToggle(rule: RuleRec, next: boolean) {
    await sendBg('rules/update', { id: rule.id, patch: { enabled: !!next } });
  }
  async function onDelete(rule: RuleRec) {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    await sendBg('rules/delete', { id: rule.id } as any);
  }
  async function runAll() {
    await sendBg('rules/runAll', { onlyEnabled: true } as any);
  }
  return (
    <div className="side-section">
      <div className="side-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Rules</span>
        <button className="btn-ghost" title="Run all enabled rules now" onClick={runAll}>Run</button>
      </div>
      
      {/* Creator */}
      <div className="side-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <input className="side-input" style={{ flex: 1 }} placeholder="Rule name" value={creating.name} onChange={(ev)=> { const v = (ev.target as HTMLInputElement)?.value ?? ''; setCreating(p=> ({ ...p, name: v })); }} />
        <select
          className="side-input"
          value={creating.groupId}
          onChange={(ev)=> {
            const v = (ev && (ev.target as HTMLSelectElement)?.value) || '';
            setCreating(p => ({ ...p, groupId: v }));
          }}
        >
          <option value="">- preset -</option>
          {groups.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
        </select>
        <select
          className="side-input"
          value={creating.actionKind}
          onChange={(ev)=> {
            const v = (ev && (ev.target as HTMLSelectElement)?.value) || 'tags';
            setCreating(p => ({ ...p, actionKind: (v === 'collections' ? 'collections' : 'tags') }));
          }}
        >
          <option value="tags">Tags</option>
          <option value="collections">Collections</option>
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={creating.enabled}
            onChange={(ev)=> {
              const next = !!(ev && (ev.target as HTMLInputElement)?.checked);
              setCreating(p => ({ ...p, enabled: next }));
            }}
          />
          enabled
        </label>
        {creating.actionKind === 'collections' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={!!creating.recursive} onChange={(ev)=> setCreating(prev => ({ ...prev, recursive: !!(ev.target as HTMLInputElement)?.checked }))} />
            recursive
          </label>
        )}
      </div>
      <div className="side-row-col">
        <div className="side-row" style={{ gap: 6 }}>
          <span className="muted" style={{ width: 60 }}>Add</span>
        {creating.actionKind === 'collections' ? (
          <select className="side-input" value="" onChange={(ev) => { const v = (ev.target as HTMLSelectElement)?.value || ''; (ev.target as HTMLSelectElement).value=''; if (v) addTo('add', v); }}>
            <option value="">+ collection</option>
            {allCollections.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </select>
        ) : (
          <select className="side-input" value="" onChange={(ev) => { const v = (ev.target as HTMLSelectElement)?.value || ''; (ev.target as HTMLSelectElement).value=''; if (v) addTo('add', v); }}>
            <option value="">+ tag</option>
            {allTagNames.map(n => (<option key={n} value={n}>{n}</option>))}
          </select>
        )}
        </div>
        <div className="side-row" style={{ gap: 6 }}>
          <span className="muted" style={{ width: 60 }}>Remove</span>
          {creating.actionKind === 'collections' ? (
            <select className="side-input" value="" onChange={(ev) => { const v = (ev.target as HTMLSelectElement)?.value || ''; (ev.target as HTMLSelectElement).value=''; if (v) addTo('remove', v); }}>
              <option value="">- collection</option>
              {allCollections.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>
          ) : (
            <select className="side-input" value="" onChange={(ev) => { const v = (ev.target as HTMLSelectElement)?.value || ''; (ev.target as HTMLSelectElement).value=''; if (v) addTo('remove', v); }}>
              <option value="">- tag</option>
              {allTagNames.map(n => (<option key={n} value={n}>{n}</option>))}
            </select>
          )}
        </div>
      </div>
      {(creating.add.length > 0 || creating.remove.length > 0) && (
        <div className="side-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(() => {
            const map = new Map<string, CollectionRec>((collections || []).map(c => [c.id, c] as [string, CollectionRec]));
            const nameOf = (val: string) => creating.actionKind === 'collections' ? (map.get(val)?.name || val) : val;
            return (
              <>
                {creating.add.map(n => (
                  <span key={`+${n}`} className={`chip${(creating.actionKind==='collections' && creating.recursive) ? ' chip-rec' : ''}`} title="click to remove" onClick={()=> removeFrom('add', n)}>+{nameOf(n)}</span>
                ))}
                {creating.remove.map(n => (
                  <span key={`-${n}`} className={`chip${(creating.actionKind==='collections' && creating.recursive) ? ' chip-rec' : ''}`} title="click to remove" onClick={()=> removeFrom('remove', n)}>-{nameOf(n)}</span>
                ))}
              </>
            );
          })()}
        </div>
      )}
      <div className="side-row" style={{ gap: 6 }}>
        <input className="side-input" style={{ flex: 1 }} placeholder="Channel IDs (optional, comma/space-separated)" value={creating.channelsText} onChange={(ev)=> { const v = (ev.target as HTMLInputElement)?.value ?? ''; setCreating(p=> ({ ...p, channelsText: v })); }} />
        {editingRuleId ? (
          <>
            <button className="btn-ghost" disabled={!creating.name.trim() || !creating.groupId} onClick={onSaveEdit}>Save</button>
            <button className="btn-ghost" onClick={onCancelEdit}>Cancel</button>
          </>
        ) : (
          <button className="btn-ghost" disabled={!creating.name.trim() || !creating.groupId} onClick={onCreate}>Create</button>
        )}
      </div>
      {/* List */}
      <div className="group-list">
        {rules.length === 0 && <div className="muted">No rules yet.</div>}
        {rules.map(r => {
          const preset = groups.find(g => g.id === r.groupId);
          return (
            <div className="group-row" key={r.id}>
              <button className="side-btn" title={preset ? `Preset: ${preset.name}` : 'Preset not found'} onClick={() => startEditRule(r)}>{r.name}</button>
              <span className="muted" style={{ fontSize: 12, flex: 1, textAlign: 'left' }}>
                {r.action?.kind === 'collections'
                  ? `Collections: ${Array.isArray((r.action as any).add) && (r.action as any).add.length ? `+${(r.action as any).add.length}` : ''}${Array.isArray((r.action as any).remove) && (r.action as any).remove.length ? ` -${(r.action as any).remove.length}` : ''}`
                  : `Tags: ${Array.isArray((r.action as any).add) && (r.action as any).add.length ? `+${(r.action as any).add.join(', ')}` : ''}${Array.isArray((r.action as any).remove) && (r.action as any).remove.length ? ` -${(r.action as any).remove.join(', ')}` : ''}`}
              </span>
              <button className="btn-ghost" aria-pressed={r.enabled !== false} title="Enabled rules run when you click 'Run'. Disabled rules are skipped." onClick={() => onToggle(r, (r.enabled === false))}>E</button>
              <button className="btn-ghost" onClick={() => onDelete(r)}>x</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
// ---- Collections UI ----
function CollectionsSection({ collections, onOpenCollection, activeCollectionId }: { collections: CollectionRec[]; onOpenCollection?: (id: string | null) => void; activeCollectionId: string | null }) {
  const [items, setItems] = React.useState<CollectionRec[]>(collections || []);
  const [creating, setCreating] = React.useState<string>('');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState<string>('');
  React.useEffect(() => { setItems(collections || []); }, [collections]);
  React.useEffect(() => {
    const h = (msg: any) => { if (msg?.type === 'db/change' && msg?.payload?.entity === 'collections') reload(); };
    chrome.runtime.onMessage.addListener(h);
    return () => chrome.runtime.onMessage.removeListener(h);
  }, []);
  const reload = React.useCallback(async () => {
    try { const r: any = await sendBg('collections/list', {} as any); setItems(Array.isArray(r?.items) ? r.items as CollectionRec[] : []); } catch { setItems([]); }
  }, []);
  async function onCreate() {
    const name = creating.trim(); if (!name) return;
    await sendBg('collections/create', { name } as any);
    setCreating('');
  }
  async function onRename(id: string) {
    const name = editName.trim(); if (!name) { setEditingId(null); return; }
    await sendBg('collections/update', { id, patch: { name } } as any);
    setEditingId(null); setEditName('');
  }
  async function onDelete(id: string) {
    if (!confirm('Delete this collection? The videos remain; membership will be removed.')) return;
    await sendBg('collections/delete', { id } as any);
    if (activeCollectionId === id) onOpenCollection?.(null);
  }
  async function onSetParent(id: string, parentId: string | null) {
    await sendBg('collections/update', { id, patch: { parentId } } as any);
  }
  const byId = new Map<string, CollectionRec>((items || []).map(c => [c.id, c] as [string, CollectionRec]));
  return (
    <div className="side-section">
      <div className="side-title">Collections</div>
      <div className="side-row" style={{ gap: 6 }}>
        <input className="side-input" style={{ flex: 1 }} placeholder="New collection name" value={creating} onChange={(ev)=> setCreating((ev.target as HTMLInputElement)?.value || '')} />
        <button className="btn-ghost" onClick={onCreate} disabled={!creating.trim()}>Create</button>
      </div>
      <div className="group-list">
        {items.length === 0 && <div className="muted">No collections yet.</div>}
        {items.map(c => (
          <div key={c.id} className="group-row">
            {editingId === c.id ? (
              <>
                <input className="side-input" value={editName} onChange={(ev)=> setEditName((ev.target as HTMLInputElement)?.value || '')} style={{ flex: 1 }} />
                <button className="btn-ghost" onClick={() => onRename(c.id)} disabled={!editName.trim()}>Save</button>
                <button className="btn-ghost" onClick={() => { setEditingId(null); setEditName(''); }}>x</button>
              </>
            ) : (
              <>
                <button
                  className="side-btn"
                  aria-pressed={activeCollectionId === c.id}
                  onClick={() => onOpenCollection?.(activeCollectionId === c.id ? null : c.id)}
                  title="Show only videos in this collection"
                >
                  {c.name}
                </button>
                <select className="side-input" value={String(c.parentId || '')} onChange={(ev)=> onSetParent(c.id, (ev && (ev.target as HTMLSelectElement)?.value) ? (ev.target as HTMLSelectElement).value : null)}>
                  <option value="">(no parent)</option>
                  {items.filter(x => x.id !== c.id).map(x => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
                <input type="color" className="side-input" value={c.color || '#333333'} onChange={(ev)=> sendBg('collections/update', { id: c.id, patch: { color: (ev.target as HTMLInputElement)?.value || '#333333' } } as any)} title="Collection color" />
                <button className="btn-ghost" onClick={() => { setEditingId(c.id); setEditName(c.name); }}>R</button>
                <button className="btn-ghost" onClick={() => onDelete(c.id)}>x</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}