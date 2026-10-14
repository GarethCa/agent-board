/** How a shell tile's pane count reads: "1 pane", "3 panes". */
export const panesLabel = (count: number): string => (count === 1 ? '1 pane' : `${count} panes`);
