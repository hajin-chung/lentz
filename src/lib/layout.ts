import type { SerializedDockview } from 'dockview-react';

/** Keep desktop proportions when a phone only changes tabs or panel contents. */
export function withDesktopGeometry(
  current: SerializedDockview,
  desktop: SerializedDockview | null,
): SerializedDockview {
  if (!desktop) return current;
  type Node = SerializedDockview['grid']['root'];
  const topology = (node: Node): string =>
    Array.isArray(node.data) ? `[${node.data.map(topology).join(',')}]` : node.data.id;
  if (topology(current.grid.root) !== topology(desktop.grid.root)) return current;
  const merge = (node: Node, old: Node): Node => {
    const oldChildren = old.data;
    if (Array.isArray(node.data) && Array.isArray(oldChildren))
      return {
        ...node,
        size: old.size,
        data: node.data.map((child, index) => merge(child, oldChildren[index])),
      };
    return { ...node, size: old.size };
  };
  return {
    ...current,
    grid: { ...desktop.grid, root: merge(current.grid.root, desktop.grid.root) },
  };
}
