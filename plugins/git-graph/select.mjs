import './select.css';

export function setSelectOptions(select, items, value, icon = '') {
  select.classList.add('codex-select');
  const button = document.createElement('button');
  button.type = 'button';
  if (icon) {
    const glyph = document.createElement('span');
    glyph.className = 'codex-select-icon';
    glyph.dataset.codexIcon = icon;
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
  }
  button.append(document.createElement('selectedcontent'));
  const option = item => {
    const element = new Option(item.label, item.value);
    if (item.title) element.title = item.title;
    return element;
  };
  select.replaceChildren(button, ...items.map(item => {
    if (!item.options) return option(item);
    const group = document.createElement('optgroup');
    group.label = item.label;
    const legend = document.createElement('legend');
    legend.textContent = item.label;
    group.append(legend, ...item.options.map(option));
    return group;
  }));
  select.value = String(value);
}
