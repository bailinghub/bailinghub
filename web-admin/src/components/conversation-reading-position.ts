// Anchor to a record rather than a pixel offset: prepending history can also merge two partial turns.
export function readingPosition(pane: HTMLElement | null) {
  if (!pane) return null;
  const top = pane.getBoundingClientRect().top;
  const header = pane.querySelector<HTMLElement>('[data-reading-header]');
  const visibleTop = Math.max(top, header?.getBoundingClientRect().bottom ?? top);
  const record = [...pane.querySelectorAll<HTMLElement>('[data-reading-id]')]
    .find(el => el.getBoundingClientRect().bottom > visibleTop);
  return {
    atEnd: pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 8,
    id: record?.dataset.readingId,
    y: record ? record.getBoundingClientRect().top - top : 0,
    top: pane.scrollTop,
  };
}

export function restoreReadingPosition(pane: HTMLElement | null, position: ReturnType<typeof readingPosition>, followEnd: boolean) {
  if (!pane) return;
  if (!position || (followEnd && position.atEnd)) {
    pane.scrollTop = pane.scrollHeight;
    return;
  }
  const record = position.id && [...pane.querySelectorAll<HTMLElement>('[data-reading-id]')]
    .find(el => el.dataset.readingId === position.id);
  if (record) pane.scrollTop += record.getBoundingClientRect().top - pane.getBoundingClientRect().top - position.y;
  else pane.scrollTop = position.top;
}
