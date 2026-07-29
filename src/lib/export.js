export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const hasExt = /\.[a-z0-9]+$/i.test(filename);
  if (hasExt) a.download = filename;
  else if (mime.includes('json')) a.download = `${filename}.json`;
  else a.download = `${filename}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename, obj) {
  const name = String(filename).endsWith('.json') ? filename : `${filename}.json`;
  downloadText(name, JSON.stringify(obj, null, 2), 'application/json');
}

export function pieceToMarkdown(p) {
  const labels = (p.labels || []).join(', ');
  const tags = (p.tags || []).join(', ');
  return `## Fragment
**Source:** ${p.sourceName || '—'}  
**Labels:** ${labels || '—'}  
**Tags:** ${tags || '—'}  
**Energy:** ${'★'.repeat(p.energy || 0) || '—'}  
**Status:** ${p.status || 'active'}

${p.text || ''}

---
`;
}

export function collectionToMarkdown(name, pieces) {
  const body = pieces.map(pieceToMarkdown).join('\n');
  return `# ${name}\n\n_Exported from Reliquary_\n\n${body}`;
}

/**
 * Export a storyboard as a working Markdown draft / outline / brainstorm.
 * @param {{ name: string, mode?: string, notes?: string, items?: any[] }} board
 */
export function storyboardToMarkdown(board) {
  const mode = board.mode || 'brainstorm';
  const modeLabel =
    mode === 'draft' ? 'Working draft' : mode === 'outline' ? 'Outline' : 'Brainstorm';
  const lines = [
    `# ${board.name || 'Storyboard'}`,
    '',
    `_Reliquary ${modeLabel} · ${new Date().toLocaleDateString()}_`,
    '',
  ];
  if (board.notes?.trim()) {
    lines.push('## Working notes', '', board.notes.trim(), '', '---', '');
  }

  const items = board.items || [];
  let pieceNum = 0;
  for (const item of items) {
    if (item.kind === 'heading') {
      lines.push(`## ${item.text || 'Section'}`, '');
      continue;
    }
    if (item.kind === 'note') {
      lines.push(`> ${((item.text || '').trim() || '_empty note_').replace(/\n/g, '\n> ')}`, '');
      continue;
    }
    // piece
    pieceNum += 1;
    const src = item.sourceName ? ` · from *${item.sourceName}*` : '';
    if (mode === 'draft') {
      lines.push(item.text || '', '', '---', '');
    } else if (mode === 'outline') {
      const labels = (item.labels || []).length ? ` (${(item.labels || []).join(', ')})` : '';
      lines.push(`${pieceNum}. **Beat${labels}**${src}`, '', item.text || '', '');
    } else {
      lines.push(`- **Fragment ${pieceNum}**${src}`, '', `  ${((item.text || '').replace(/\n/g, '\n  '))}`, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}
