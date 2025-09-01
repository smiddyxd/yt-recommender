// src/ui/options/components/Sidebar.tsx
import React from 'react';
import type { Group as GroupRec } from '../../../shared/conditions';
import type { TagRec } from '../../../types/messages';

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
  tagGroups: Array<{ id: string; name: string }>;
  onCreateTagGroup: (name: string)=>void;
  onRenameTagGroup: (id: string, name: string)=>void;
  onDeleteTagGroup: (id: string)=>void;
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
} = props;

  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = React.useState<'tags'|'groups'>('tags');
  const [newGroup, setNewGroup] = React.useState('');
  const [editingGroupId, setEditingGroupId] = React.useState<string | null>(null);
  const [groupEditName, setGroupEditName] = React.useState('');

  return (
    <aside className="sidebar">
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
                  placeholder="New tag…"
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
                  title="Import a JSON mapping: { tagName: [channelId,…] }"
                >
                  Import JSON
                </button>
                {importing && (
                  <span className="muted" style={{ marginLeft: 8 }}>{importMessage || 'Importing…'}</span>
                )}
              </div>

              {/* List of tags with rename/delete and group selector */}
              <div className="tag-list">
                {tags.length === 0 && <div className="muted">No tags yet.</div>}
                {tags.map(t => (
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
                          value={t.groupId || ''}
                          onChange={(e) => onAssignTagToGroup(t.name, e.currentTarget.value ? e.currentTarget.value : null)}
                          title="Assign to tag group"
                        >
                          <option value="">— no group —</option>
                          {tagGroups.map(g => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                        <button className="btn-ghost" onClick={() => startRename(t.name)}>R</button>
                        <button className="btn-ghost" onClick={() => removeTag(t.name)}>x</button>
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
                  placeholder="New group…"
                  value={newGroup}
                  onChange={(e)=> setNewGroup(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newGroup.trim()) { onCreateTagGroup(newGroup.trim()); setNewGroup(''); } }}
                />
                <button className="btn-ghost" onClick={() => { if (newGroup.trim()) { onCreateTagGroup(newGroup.trim()); setNewGroup(''); } }} disabled={!newGroup.trim()}>
                  Add
                </button>
              </div>
              <div className="group-list">
                {tagGroups.length === 0 && <div className="muted">No groups yet.</div>}
                {tagGroups.map(g => (
                  <div className="group-row" key={g.id}>
                    {editingGroupId === g.id ? (
                      <>
                        <input className="side-input" value={groupEditName} onChange={(e)=> setGroupEditName(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter'){ onRenameTagGroup(g.id, groupEditName.trim()); setEditingGroupId(null); setGroupEditName(''); } if(e.key==='Escape'){ setEditingGroupId(null); setGroupEditName(''); } }} autoFocus />
                        <button className="btn-ghost" onClick={()=>{ onRenameTagGroup(g.id, groupEditName.trim()); setEditingGroupId(null); setGroupEditName(''); }} disabled={!groupEditName.trim()}>Save</button>
                        <button className="btn-ghost" onClick={()=>{ setEditingGroupId(null); setGroupEditName(''); }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="tag-name">{g.name}</span>
                        <button className="btn-ghost" onClick={()=>{ setEditingGroupId(g.id); setGroupEditName(g.name); }}>Rename</button>
                        <button className="btn-ghost" onClick={()=> onDeleteTagGroup(g.id)}>Delete</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

        </div>
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
                  title={isPresetScrapeCheckable && !isPresetScrapeCheckable(g.id) ? 'Contains unsupported predicates for scrape-time; cannot enable' : 'Toggle scrape flag (S)'}
                  onClick={() => toggleGroupScrape?.(g.id, !(g as any).scrape)}
                  aria-pressed={(g as any).scrape === true}
                  disabled={isPresetScrapeCheckable ? !isPresetScrapeCheckable(g.id) : false}
                >
                  S
                </button>
                <button className="btn-ghost" onClick={() => removeGroup(g.id)} title="Delete preset">x</button>
              </div>
            ))}
          </div>
        </div>

        <div className="side-section">
          <div className="side-title">Coming up</div>
          <ul className="side-list">
            <li>Tags</li>
            <li>Rules</li>
            <li>Presets</li>
          </ul>
        </div>

        <div className="side-section">
          <div className="side-title">Backup</div>
          <div className="side-row" title={driveClientId ? driveClientId : ''}>
            <span className="muted" style={{ flex: 1 }}>
              Client ID: {driveClientId ? `${driveClientId.slice(0,6)}…${driveClientId.slice(-10)}` : '(not set)'}
            </span>
          </div>
          <div className="side-row" style={{ gap: 8 }}>
            <button className="btn-ghost" onClick={onSetDriveClientId}>Set Client ID</button>
            <button className="btn-ghost" onClick={onBackupNow}>Backup Settings</button>
            <button className="btn-ghost" onClick={onOpenHistory}>Version History</button>
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.2 }}>
            Uses Google Drive appDataFolder. During backup you’ll be asked to sign in. Optional passphrase encrypts data locally.
          </div>
        </div>
      </aside>
  );
}
