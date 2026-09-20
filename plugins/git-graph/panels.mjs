const $ = id => document.getElementById(id);

export function createPanels({ ready, save }) {
  let preferences = {}, drag = null;
  const detailOpen = () => !$('detail-row').hidden;
  const size = (id, axis = 'height') => $(id).getBoundingClientRect()[axis];
  const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
  const splits = [
    { id: 'detail', key: 'detailHeight', axis: 'height',
      bounds: () => [240, Math.max(240, $('history-scroll').clientHeight - 60)] },
    { id: 'files', key: 'filesWidth', axis: 'width',
      bounds: () => [96, Math.max(96, size('detail-body', 'width') - 181)] },
    { id: 'summary', key: 'summaryHeight', axis: 'height',
      bounds: () => [64, Math.max(64, size('detail-content') - size('changes-header') - 128)] },
  ];
  const target = split => split.id === 'detail' ? 'detail' : `${split.id}-pane`;
  function render() {
    const open = detailOpen();
    $('history-pane').style.setProperty('--history-viewport-width', `${$('history-scroll').clientWidth}px`);
    $('history-pane').classList.toggle('detail-maximized', Boolean(preferences.detailMaximized) && open);
    $('expand-detail').disabled = !ready();
    $('expand-detail').setAttribute('aria-pressed', String(Boolean(preferences.detailMaximized)));
    $('expand-detail').title = Boolean(preferences.detailMaximized) ? '恢复历史与详情布局' : '放大详情';
    $('expand-detail').setAttribute('aria-label', $('expand-detail').title);
    const [min, max] = splits[0].bounds();
    const detailSize = clamp(preferences.detailHeight ?? Math.min(480, max * .8), min, max);
    $('detail').style.setProperty('--detail-height', `${detailSize}px`);
    if (open) {
      $('files-pane').style.setProperty('--files-width', `${clamp(preferences.filesWidth ?? 220, ...splits[1].bounds())}px`);
    }
    if (open && preferences.summaryHeight != null) {
      $('summary-pane').style.setProperty('--summary-height', `${clamp(preferences.summaryHeight, ...splits[2].bounds())}px`);
    } else $('summary-pane').style.removeProperty('--summary-height');
    for (const split of splits) {
      const handle = $(`${split.id}-resize`), horizontal = split.axis === 'height';
      handle.hidden = !open || (split.id === 'detail' && Boolean(preferences.detailMaximized));
      handle.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
      const [min, max] = split.bounds();
      handle.setAttribute('aria-valuemin', min); handle.setAttribute('aria-valuemax', Math.round(max));
      handle.setAttribute('aria-valuenow', Math.round(size(target(split), split.axis)));
      handle.setAttribute('aria-valuetext', `${Math.round(size(target(split), split.axis))} 像素`);
      handle.setAttribute('aria-disabled', String(!ready())); handle.tabIndex = ready() ? 0 : -1;
    }
  }
  function setMaximized(value) {
    if (!ready()) return;
    preferences.detailMaximized = value;
    render(); save();
  }
  $('expand-detail').addEventListener('click', () => setMaximized(!preferences.detailMaximized));
  function finish(cancelled) {
    if (!drag) return;
    const previous = drag.previous, handle = drag.handle, pointer = drag.pointer;
    drag = null; delete handle.dataset.active;
    document.documentElement.classList.remove('panel-resizing');
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    if (cancelled) preferences = previous;
    render();
    if (!cancelled && JSON.stringify(previous) !== JSON.stringify(preferences)) save();
  }
  for (const split of splits) {
    const handle = $(`${split.id}-resize`);
    const resize = value => { preferences[split.key] = clamp(value, ...split.bounds()); render(); };
    const reset = () => { delete preferences[split.key]; render(); save(); };
    handle.addEventListener('pointerdown', event => {
      if (!ready() || event.button !== 0 || drag) return;
      event.preventDefault(); handle.focus({ preventScroll: true });
      const axis = split.axis;
      drag = { handle, pointer: event.pointerId, previous: { ...preferences }, axis,
        position: axis === 'height' ? event.clientY : event.clientX, size: size(target(split), axis),
        scroll: $('history-scroll').scrollTop };
      handle.setPointerCapture(event.pointerId); handle.dataset.active = '';
      document.documentElement.style.setProperty('--resize-cursor', axis === 'height' ? 'row-resize' : 'col-resize');
      document.documentElement.classList.add('panel-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (drag?.handle !== handle || drag.pointer !== event.pointerId) return;
      const delta = (drag.axis === 'height' ? event.clientY : event.clientX) - drag.position;
      resize(drag.size + delta + (drag.axis === 'height' ? $('history-scroll').scrollTop - drag.scroll : 0));
    });
    handle.addEventListener('pointerup', () => finish(false));
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish(true));
    handle.addEventListener('dblclick', () => { if (ready()) reset(); });
    handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      if (!ready() || drag) return;
      const [decrease, increase] = split.axis === 'height' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      if (event.key === decrease || event.key === increase) {
        event.preventDefault(); resize(size(target(split), split.axis) + (event.key === increase ? 1 : -1) * (event.shiftKey ? 1 : 8)); save();
      } else if (event.key === 'Home') { event.preventDefault(); reset(); }
    });
  }
  const observer = new ResizeObserver(render);
  observer.observe($('history-scroll')); observer.observe($('detail-content')); observer.observe($('detail-body'));
  render();
  return { get preferences() { return { ...preferences }; },
    load(value) { preferences = value; render(); }, render, setMaximized,
    dispose() { finish(true); observer.disconnect(); } };
}
