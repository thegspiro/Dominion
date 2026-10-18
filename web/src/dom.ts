type Child = Node | string;

/** Small helper for building elements; text always goes in as text, never as markup. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) {
    node.className = props.className;
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

export function button(label: string, onClick: () => void, options: { aria?: string; className?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const node = el('button', {
    text: label,
    className: options.className,
    attrs: { type: 'button', ...(options.aria ? { 'aria-label': options.aria } : {}) },
  });
  node.disabled = options.disabled ?? false;
  node.addEventListener('click', onClick);
  return node;
}
