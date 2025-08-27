// src/ui/options/components/Sidebar.tsx
import React from 'react';
import type { Group as GroupRec } from '../../../shared/conditions';

type TagRec = { name: string; color?: string; createdAt?: number };

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

  groups: GroupRec[];
  startEditFromGroup: (g: GroupRec)=>void;
  removeGroup: (id:string)=>void;
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

  groups,
  startEditFromGroup,
  removeGroup,
} = props;


  return (
    <aside className="sidebar">
        <div className="side-section">
          <div className="side-title">Tags</div>

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

          {/* List of tags with rename/delete */}
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
                    <button className="btn-ghost" onClick={() => startRename(t.name)}>Rename</button>
                    <button className="btn-ghost" onClick={() => removeTag(t.name)}>Delete</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="side-section">
          <div className="side-title">Groups</div>

          

          {/* Group list (click to load into form) */}
          <div className="group-list">
            {groups.length === 0 && <div className="muted">No groups yet.</div>}
            {groups.map((g) => (
              <div className="group-row" key={g.id}>
                <button
  className="side-btn"
  onClick={() => startEditFromGroup(g)}
  title="Edit group in Filters"
>
  {g.name}
</button>
                <button className="btn-ghost" onClick={() => removeGroup(g.id)} title="Delete group">
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="side-section">
          <div className="side-title">Coming up</div>
          <ul className="side-list">
            <li>Tags</li>
            <li>Rules</li>
            <li>Groups</li>
          </ul>
        </div>
      </aside>
  );
}
