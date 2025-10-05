// src/ui/options/components/Sidebar.tsx
import React from 'react';
import type { Group as GroupRec } from '../../../shared/conditions';
import type { TagRec, TagGroupRec, RuleRec, CollectionRec } from '../../../types/messages';
import { send as sendBg } from '../../lib/messaging';
import RecsSidebar from './RecsSidebar';

// NOTE: "Groups" are called "Presets" in the UI. Keep this comment forever.
// The underlying storage/type is still named Group for compatibility.
type Props = {
  tags: TagRec[];
  newTag: string;
  setNewTag: (s:string)=>void;
  tagEditing: string | null;
  tagEditValue: string;
  setTagEditValue: (s:string)=>void;
  startRename: (name:string)=>void;
  cancelRename: ()=>void;
  commitRename: ()=>void;
  addTag: ()=>void;
  removeTag: (name:string)=>void;
  tagGroups: TagGroupRec[];
  onCreateTagGroup: (name: string)=>void;
  onRenameTagGroup: (id: string, name: string)=>void;
  onDeleteTagGroup: (id: string)=>void;
  onUpdateTagGroup?: (id: string, patch: Partial<TagGroupRec>)=>void;
  onAssignTagToGroup: (tagName: string, groupId: string | null)=>void;
  // One-time import: channel tags JSON
  importing?: boolean;
  importMessage?: string | null;
  onImportFile?: (file: File) => void;

  groups: GroupRec[];
  startEditFromGroup: (g: GroupRec)=>void;
  removeGroup: (id:string)=>void;
  isPresetScrapeCheckable?: (id: string) => boolean;
  toggleGroupScrape?: (id: string, next: boolean) => void;
  // Backup (Google Drive)
  driveClientId?: string | null;
  onSetDriveClientId?: () => void;
  onBackupNow?: () => void;
  onOpenHistory?: () => void;
  // Top-level Options mode
  mode: 'manager' | 'subs' | 'recommender';
  onModeChange: (m: 'manager' | 'subs' | 'recommender') => void;
  // Recommender global toggle (for editor stats)
  respectDontRecommend?: boolean;
  // Collections
  collections?: CollectionRec[];
  activeCollectionId?: string | null;
  onOpenCollection?: (id: string | null) => void;
};

export default function Sidebar(props: Props) {
    const {
  tags,
  newTag,
  setNewTag,
  tagEditing,
  tagEditValue,
  setTagEditValue,
  startRename,
  cancelRename,
  commitRename,
  addTag,
  removeTag,
  tagGroups,
  onCreateTagGroup,
  onRenameTagGroup,
  onDeleteTagGroup,
  onUpdateTagGroup,
  onAssignTagToGroup,
  importing,
  importMessage,
  onImportFile,

  groups,
  startEditFromGroup,
  removeGroup,
  isPresetScrapeCheckable,
  toggleGroupScrape,
  driveClientId,
  onSetDriveClientId,
  onBackupNow,
  onOpenHistory,
  mode,
  onModeChange,
  collections,
  activeCollectionId,
  onOpenCollection,
} = props;

  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = React.useState<'tags'|'groups'>('tags');
  const [newGroup, setNewGroup] = React.useState('');
  const [editingGroupId, setEditingGroupId] = React.useState<string | null>(null);
  const [groupEditName, setGroupEditName] = React.useState('');

  // Hide system default tags and the default tag group from the Sidebar (edit/delete area)
  const defaultTagNames = React.useMemo(() => new Set(['no fetch','hide','subscribed','unsubscribed','tagged','scrape','0','1','2','3','4','5','6','7','8','9','10']), []);
  const visibleTags = React.useMemo(() => (tags || []).filter(t => !defaultTagNames.has(String(t.name || '').toLowerCase())), [tags, defaultTagNames]);
  const visibleTagGroups = React.useMemo(() => (tagGroups || []).filter(g => {
    const nm = String(g.name || '').trim().toLowerCase();
    return g.id !== 'tagGroup.default' && nm !== 'default tags' && g.id !== 'tagGroup.rating' && nm !== 'rating';
  }), [tagGroups]);

  return (
    <aside className="sidebar">
        {/* Top-level tabs: Manager / Subs / Recommender (fixed, non-scrolling) */}
        <div className="top-tabs" role="tablist" aria-label="Options sections">
          <button
            className="top-tab"
            role="tab"
            aria-selected={mode === 'manager'}
            aria-current={mode === 'manager'}
            onClick={() => onModeChange('manager')}
          >
            Manager
          </button>
          <button
            className="top-tab"
            role="tab"
            aria-selected={mode === 'subs'}
            aria-current={mode === 'subs'}
            onClick={() => onModeChange('subs')}
          >
            Subs
          </button>
          <button
            className="top-tab"
            role="tab"
            aria-selected={mode === 'recommender'}
            aria-current={mode === 'recommender'}
            onClick={() => onModeChange('recommender')}
          >
            Recommender
          </button>
        </div>

        <div className="sidebar-body">
        {mode === 'manager' ? (
        <div className="side-section">
          <div className="side-title" style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" aria-pressed={tab==='tags'} onClick={()=>setTab('tags')}>Tags</button>
            <button className="btn-ghost" aria-pressed={tab==='groups'} onClick={()=>setTab('groups')}>Tag Groups</button>
          </div>
          {tab === 'tags' ? (
            <>
              {/* Create new tag */}
              <div className="side-row">
                <input
                  className="side-input"
                  type="text"
                  placeholder="New tag..."
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }}
                />
                <button className="btn-ghost" onClick={addTag} disabled={!newTag.trim()}>
                  Add
                </button>
              </div>

              {/* One-time import of channel tags from JSON */}
              <div className="side-row">
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f && onImportFile) onImportFile(f);
                    // reset value so selecting the same file again triggers change
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
                <button
                  className="btn-ghost"
                  onClick={() => fileRef.current?.click()}
                  disabled={!!importing}
                  title="Import a JSON mapping: { tagName: [channelId,...] }"
                >
                  Import JSON
                </button>
                {importing && (
                  <span className="muted" style={{ marginLeft: 8 }}>{importMessage || 'Importing...'}</span>
                )}
              </div>

              {/* List of tags with rename/delete and group selector */}
              <div className="tag-list">
                {visibleTags.length === 0 && <div className="muted">No tags yet.</div>}
                {visibleTags.map(t => (
                  <div className="tag-row" key={t.name}>
                    {tagEditing === t.name ? (
                      <>
                        <input
                          className="side-input"
                          type="text"
                          value={tagEditValue}
                          onChange={(e) => setTagEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') cancelRename();
                          }}
                          autoFocus
                        />
                        <button className="btn-ghost" onClick={commitRename} disabled={!tagEditValue.trim()}>Save</button>
                        <button className="btn-ghost" onClick={cancelRename}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="tag-name">{t.name}</span>
                        <select
                          className="side-input"
                          value={(t.groupId === 'tagGroup.default' || !t.groupId) ? '' : (t.groupId as any)}
                          onChange={(ev) => onAssignTagToGroup(t.name, (ev && (ev.target as HTMLSelectElement)?.value) ? (ev.target as HTMLSelectElement).value : null)}
                          title="Assign to tag group"
                          disabled={['no fetch','hide','subscribed','unsubscribed','tagged','scrape'].includes(String(t.name).toLowerCase())}
                        >
                          <option value="">{"\u2014 no group \u2014"}</option>
                          {visibleTagGroups.map(g => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                        <button className="btn-ghost" onClick={() => startRename(t.name)} disabled={defaultTagNames.has(String(t.name).toLowerCase())}>R</button>
                        <button className="btn-ghost" onClick={() => removeTag(t.name)} disabled={defaultTagNames.has(String(t.name).toLowerCase())}>x</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* Tag Groups tab */}
              <div className="side-row">
                <input
                  className="side-input"
                  type="text"
                  placeholder="New group..."
                  value={newGroup}
                  onChange={(e)=> setNewGroup(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newGroup.trim()) { onCreateTagGroup(newGroup.trim()); setNewGroup(''); } }}
                />
                <button className="btn-ghost" onClick={() => { if (newGroup.trim()) { onCreateTagGroup(newGroup.trim()); setNewGroup(''); } }} disabled={!newGroup.trim()}>
                  Add
                </button>
              </div>
              <div className="group-list">
                {visibleTagGroups.length === 0 && <div className="muted">No groups yet.</div>}
                {visibleTagGroups.map(g => {
                  const isParent = !g.parentId;
                  const parentOptions = (tagGroups || []).filter(pg => (!pg.parentId) && pg.id !== g.id);
                  const parentTitle = 'Assign parent tag group (select "parent" to make this a parent)';
                  const color = (g.color && /^#?[0-9a-fA-F]{6}$/.test(g.color)) ? (g.color.startsWith('#') ? g.color : `#${g.color}`) : undefined;
                  return (
                  <div className="group-row" key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
                    {editingGroupId === g.id ? (
                      <>
                        <input className="side-input" value={groupEditName} onChange={(e)=> setGroupEditName(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter'){ onRenameTagGroup(g.id, groupEditName.trim()); setEditingGroupId(null); setGroupEditName(''); } if(e.key==='Escape'){ setEditingGroupId(null); setGroupEditName(''); } }} autoFocus />
                        <button className="btn-ghost" onClick={()=>{ onRenameTagGroup(g.id, groupEditName.trim()); setEditingGroupId(null); setGroupEditName(''); }} disabled={!groupEditName.trim()}>Save</button>
                        <button className="btn-ghost" onClick={()=>{ setEditingGroupId(null); setGroupEditName(''); }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="tag-name">{g.name}</span>
                        {/* Parent selector */}
                        <select
                          className="side-input"
                          title={parentTitle}
                          value={isParent ? '' : (g.parentId as string)}
                          onChange={(ev) => onUpdateTagGroup?.(g.id, { parentId: (ev && (ev.target as HTMLSelectElement)?.value) ? (ev.target as HTMLSelectElement).value : null })}
                          style={{ minWidth: 110 }}
                        >
                          <option value="">parent</option>
                          {parentOptions.map(pg => (
                            <option key={pg.id} value={pg.id}>{pg.name}</option>
                          ))}
                        </select>
                        {/* Color picker */}
                        <input
                          type="color"
                          title="Tag group color"
                          value={color || '#888888'}
                          onChange={(ev) => onUpdateTagGroup?.(g.id, { color: (ev.target as HTMLInputElement)?.value || '' })}
                          style={{ width: 23, height: 26, padding: 0, border: '1px solid var(--border)', background: '#111' }}
                        />
                        <button className="btn-ghost" onClick={()=>{ setEditingGroupId(g.id); setGroupEditName(g.name); }} disabled={g.id === 'tagGroup.default'} style={{ width: 22, height: 22, lineHeight: '20px', padding: 0 }}>R</button>
                        <button className="btn-ghost" onClick={()=> onDeleteTagGroup(g.id)} disabled={g.id === 'tagGroup.default'} style={{ width: 22, height: 22, lineHeight: '20px', padding: 0 }}>x</button>
                      </>
                    )}
                  </div>
                ); })}
              </div>
            </>
          )}

        </div>
        ) : null}
        {mode === 'subs' ? (
          <div className="side-section">
            <div className="side-title">Subs</div>
            <div className="muted" style={{ fontSize: 13 }}>
              This panel will host subscription feed filters and options.
            </div>
          </div>
        ) : null}
        {mode === 'recommender' ? (
          <RecsSidebar groups={groups} respectDontRecommend={props.respectDontRecommend === false ? false : true} />
        ) : null}
          <div className="side-section">
          <div className="side-title">Presets</div>
          {/* Preset list (click to load into form) */}
          <div className="group-list">
            {groups.length === 0 && <div className="muted">No presets yet.</div>}
            {groups.map((g) => (
              <div className="group-row" key={g.id}>
                <button
                  className="side-btn"
                  onClick={() => startEditFromGroup(g)}
                  title="Edit preset in Filters"
                >
                  {g.name}
                </button>
                <button
                  className="btn-ghost"
                  title={g.id === 'group.default.scrapable' ? 'Always enabled for default preset' : (isPresetScrapeCheckable && !isPresetScrapeCheckable(g.id) ? 'Contains unsupported predicates for scrape-time; cannot enable' : 'Toggle scrape flag (S)')}
                  onClick={() => toggleGroupScrape?.(g.id, !(g as any).scrape)}
                  aria-pressed={(g as any).scrape === true}
                  disabled={g.id === 'group.default.scrapable' || (isPresetScrapeCheckable ? !isPresetScrapeCheckable(g.id) : false)}
                >
                  S
                </button>
                <button className="btn-ghost" onClick={() => removeGroup(g.id)} title="Delete preset" disabled={g.id === 'group.default.scrapable'}>x</button>
              </div>
            ))}
          </div>
        </div>

        {/* Rules section (below Presets) */}
        <RulesSection tags={tags} groups={groups} collections={collections || []} />

        {/* Collections section (below Rules) */}
        <CollectionsSection
          collections={collections || []}
          onOpenCollection={onOpenCollection}
          activeCollectionId={activeCollectionId || null}
        />

        {mode === 'manager' && (
          <div className="side-section">
            <div className="side-title">Backup</div>
            <div className="side-row" title={driveClientId ? driveClientId : ''}>
              <span className="muted" style={{ flex: 1 }}>
                Client ID:  {driveClientId ? `${driveClientId.slice(0,6)}...${driveClientId.slice(-10)}` : '(not set)'}
              </span>
            </div>
            <div className="side-row" style={{ gap: 8 }}>
              <button className="btn-ghost" onClick={onSetDriveClientId}>Set Client ID</button>
              <button className="btn-ghost" onClick={onBackupNow}>Backup Settings</button>
              <button className="btn-ghost" onClick={onOpenHistory}>Backups</button>
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.2 }}>
              Uses Google Drive appDataFolder. During backup you may be asked to sign in.
            </div>
          </div>
        )}
        </div>
      </aside>
  );
}

// ---- Rules UI ----
function RulesSection({ tags, groups, collections }: { tags: TagRec[]; groups: GroupRec[]; collections: CollectionRec[] }) {
  const [rules, setRules] = React.useState<RuleRec[]>([]);
  const [creating, setCreating] = React.useState<{ name: string; groupId: string; add: string[]; remove: string[]; channelsText: string; enabled: boolean; actionKind: 'tags'|'collections'|'delete'|'purge'; recursive?: boolean }>({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false   } );
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
    const channelIds = creating.channelsText.split(/[\,\s]+/).map(s => s.trim()).filter(Boolean);
    const action: any = (() => {
      if (creating.actionKind === 'collections') return { kind: 'collections', add: creating.add, remove: creating.remove, recursive: !!creating.recursive } as const;
      if (creating.actionKind === 'delete') return { kind: 'delete' } as const;
      if (creating.actionKind === 'purge') return { kind: 'purge' } as const;
      return { kind: 'tags', add: creating.add, remove: creating.remove } as const;
    })();
    try {
      await sendBg('rules/create', { name, groupId, action, channelIds, enabled: !!creating.enabled } as any);
      setEditingRuleId(null);
      setCreating({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false });
    } catch {}
  }

  function startEditRule(rule: RuleRec) {
    const actionKind = (((rule as any)?.action as any)?.kind ?? 'tags') as 'tags'|'collections'|'delete'|'purge';
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
      } );
    setEditingRuleId(rule.id);
  }

  async function onSaveEdit() {
    if (!editingRuleId) return;
    const name = creating.name.trim();
    const groupId = creating.groupId.trim();
    if (!name || !groupId) return;
    const channelIds = creating.channelsText.split(/[\,\s]+/).map(s => s.trim()).filter(Boolean);
    const action: any = (() => {
      if (creating.actionKind === 'collections') return { kind: 'collections', add: creating.add, remove: creating.remove, recursive: !!creating.recursive } as const;
      if (creating.actionKind === 'delete') return { kind: 'delete' } as const;
      if (creating.actionKind === 'purge') return { kind: 'purge' } as const;
      return { kind: 'tags', add: creating.add, remove: creating.remove } as const;
    })();
    try {
      await sendBg('rules/update', { id: editingRuleId, patch: { name, groupId, action, channelIds, enabled: !!creating.enabled } } as any);
      setEditingRuleId(null);
      setCreating({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false });
    } catch {}
  }
  function onCancelEdit() {
    setEditingRuleId(null);
    setCreating({ name: '', groupId: '', add: [], remove: [], channelsText: '', enabled: true, actionKind: 'tags', recursive: false });
  }
  async function onToggle(rule: RuleRec, next: boolean) {
    try { await sendBg('rules/update', { id: rule.id, patch: { enabled: !!next } } as any); } catch {}
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
            const allowed = new Set(['tags','collections','delete','purge']);
            setCreating(p => ({ ...p, actionKind: (allowed.has(v) ? (v as any) : 'tags') }));
          }}
        >
          <option value="tags">Tags</option>
          <option value="collections">Collections</option>
          <option value="delete">Delete videos</option>
          <option value="purge">Purge videos</option>
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
      {(creating.actionKind !== 'delete' && creating.actionKind !== 'purge') && (
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
      )}
      {(creating.actionKind !== 'delete' && creating.actionKind !== 'purge') && (creating.add.length > 0 || creating.remove.length > 0) && (
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













