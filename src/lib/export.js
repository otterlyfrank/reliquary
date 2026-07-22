export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') || filename.endsWith('.txt') ? filename : `${filename}.md`;
  a.click();
  URL.revokeObjectURL(url);
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
