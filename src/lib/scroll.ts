export interface ScrollAnchor {
  selector?: string;
  offset: number;
  top: number;
  height: number;
}
export function captureScroll(element: HTMLElement): ScrollAnchor {
  const viewport = element.getBoundingClientRect();
  const visible = (selector: string) =>
    [...element.querySelectorAll<HTMLElement>(selector)].find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
  const item = visible('[data-message-id], [data-scroll-key]') || visible('[data-group-id]');
  return {
    selector: item
      ? item.dataset.scrollKey !== undefined
        ? `[data-scroll-key="${CSS.escape(item.dataset.scrollKey)}"]`
        : item.dataset.messageId !== undefined
          ? `[data-message-id="${item.dataset.messageId}"]`
          : `[data-group-id="${item.dataset.groupId}"]`
      : undefined,
    offset: item ? item.getBoundingClientRect().top - viewport.top : 0,
    top: element.scrollTop,
    height: element.scrollHeight,
  };
}
export function restoreScroll(element: HTMLElement, anchor: ScrollAnchor) {
  const item = anchor.selector ? element.querySelector(anchor.selector) : null;
  if (item)
    element.scrollTop +=
      item.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
  else element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
}
