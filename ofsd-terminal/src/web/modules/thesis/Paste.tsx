import { useMemo, useState } from 'react';
import { execute } from '../../lib/commands.ts';
import { parsePosts, setPendingPosts } from '../../local/thesis.ts';

/** Claude-app version: posts are pasted in (the page can't reach X). */
export function PastePanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const posts = useMemo(() => (text.trim() ? parsePosts(text) : []), [text]);
  const accounts = new Set(posts.map((p) => p.handle)).size;
  const go = () => {
    if (!posts.length) return;
    setPendingPosts(text);
    onClose();
    execute('/thesis');
  };
  return (
    <div className="th-confirm" role="dialog" aria-label="Paste today's posts">
      <div className="th-confirm__box">
        <div className="label">Paste today's posts</div>
        <div className="th-hint" style={{ marginTop: 0 }}>
          Copy posts from X (select them in your timeline or a list and press Ctrl+C) and paste them below. You can also type one per line as
          {' '}<span className="mono">@handle: text</span>. Blank lines separate posts.
        </div>
        <textarea
          id="thesis-paste"
          className="th-pastebox"
          value={text}
          autoFocus
          placeholder={'@NickTimiraos: Fed officials signal patience on further cuts...\n\n@bondtrader: 2s10s back to 50bp, steepener led by the front end...'}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="th-actions">
          <span className="th-hint mono" style={{ marginTop: 0 }}>
            {posts.length ? `${posts.length} posts from ${accounts} account${accounts === 1 ? '' : 's'}` : 'No posts yet'}
          </span>
          <span className="th-actions__spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!posts.length} onClick={go}>
            Build thesis
          </button>
        </div>
      </div>
    </div>
  );
}
