import type { PanelLayout } from './layout.ts';
const $ = (id: string) => document.getElementById(id)!;
type Split = { id: string; key: 'detailHeight' | 'filesWidth' | 'summaryHeight'; axis: 'height' | 'width'; bounds(): [number, number] };
export type PanelView = { ready: boolean; maximized: boolean; width: number; detail: number; files?: number; summary?: number;
  handles: Record<string, { min: number; max: number; now: number; hidden: boolean; horizontal: boolean }> };
export function createPanels({ ready, save, changed }: { ready(): boolean; save(): void; changed(view: PanelView, sync: boolean): void }) {
  let preferences: PanelLayout = {}, drag: { previous: PanelLayout; handle: HTMLElement; pointer: number; axis: 'height' | 'width'; position: number; size: number; scroll: number } | null = null;
  const events = new AbortController();
  const size = (id: string, axis: 'height' | 'width' = 'height') => $(id).getBoundingClientRect()[axis];
  const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)));
  const splits: Split[] = [
    { id: 'detail', key: 'detailHeight', axis: 'height', bounds: () => [240, Math.max(240, $('history-scroll').clientHeight - 60)] },
    { id: 'files', key: 'filesWidth', axis: 'width', bounds: () => [96, Math.max(96, size('detail-body', 'width') - 181)] },
    { id: 'summary', key: 'summaryHeight', axis: 'height', bounds: () => [64, Math.max(64, size('detail-content') - size('changes-header') - 128)] },
  ];
  const target = (split: Split) => split.id === 'detail' ? 'detail' : `${split.id}-pane`;
  let previousView = '';
  function render(sync = false) {
    const open = !$('detail-row').hidden;
    const [min, max] = splits[0].bounds();
    const view: PanelView = { ready: ready(), maximized: Boolean(preferences.detailMaximized), width: $('history-scroll').clientWidth,
      detail: clamp(preferences.detailHeight ?? Math.min(480, max * .8), min, max),
      files: open ? clamp(preferences.filesWidth ?? 220, ...splits[1].bounds()) : undefined,
      summary: open && preferences.summaryHeight != null ? clamp(preferences.summaryHeight, ...splits[2].bounds()) : undefined,
      handles: Object.fromEntries(splits.map(split => { const [min, max] = split.bounds(); return [split.id, {
        min, max: Math.round(max), now: Math.round(size(target(split), split.axis)),
        hidden: !open || (split.id === 'detail' && Boolean(preferences.detailMaximized)), horizontal: split.axis === 'height',
      }]; })) };
    const serialized = JSON.stringify(view);
    if (serialized !== previousView) { previousView = serialized; changed(view, sync); }
  }
  function setMaximized(value: boolean) { if (ready()) { preferences.detailMaximized = value; render(true); save(); } }
  function finish(cancelled: boolean) {
    if (!drag) return;
    const { previous, handle, pointer } = drag;
    drag = null; delete handle.dataset.active;
    document.documentElement.classList.remove('panel-resizing');
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    if (cancelled) preferences = previous;
    render();
    if (!cancelled && JSON.stringify(previous) !== JSON.stringify(preferences)) save();
  }
  for (const split of splits) {
    const handle = $(`${split.id}-resize`), options = { signal: events.signal };
    const resize = (value: number) => { preferences[split.key] = clamp(value, ...split.bounds()); render(true); };
    const reset = () => { delete preferences[split.key]; render(true); save(); };
    handle.addEventListener('pointerdown', event => {
      if (!ready() || event.button !== 0 || drag) return;
      event.preventDefault(); handle.focus({ preventScroll: true });
      const axis = split.axis;
      drag = { handle, pointer: event.pointerId, previous: { ...preferences }, axis,
        position: axis === 'height' ? event.clientY : event.clientX, size: size(target(split), axis), scroll: $('history-scroll').scrollTop };
      handle.setPointerCapture(event.pointerId); handle.dataset.active = '';
      document.documentElement.style.setProperty('--resize-cursor', axis === 'height' ? 'row-resize' : 'col-resize');
      document.documentElement.classList.add('panel-resizing');
    }, options);
    handle.addEventListener('pointermove', event => {
      if (drag?.handle !== handle || drag.pointer !== event.pointerId) return;
      const delta = (drag.axis === 'height' ? event.clientY : event.clientX) - drag.position;
      resize(drag.size + delta + (drag.axis === 'height' ? $('history-scroll').scrollTop - drag.scroll : 0));
    }, options);
    handle.addEventListener('pointerup', () => finish(false), options);
    handle.addEventListener('pointercancel', () => finish(true), options);
    handle.addEventListener('lostpointercapture', () => finish(true), options);
    handle.addEventListener('dblclick', () => { if (ready()) reset(); }, options);
    handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      if (!ready() || drag) return;
      const [decrease, increase] = split.axis === 'height' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      if (event.key === decrease || event.key === increase) {
        event.preventDefault(); resize(size(target(split), split.axis) + (event.key === increase ? 1 : -1) * (event.shiftKey ? 1 : 8)); save();
      } else if (event.key === 'Home') { event.preventDefault(); reset(); }
    }, options);
  }
  const observer = new ResizeObserver(() => render());
  observer.observe($('history-scroll')); observer.observe($('detail-content')); observer.observe($('detail-body'));
  render();
  return { get preferences() { return { ...preferences }; }, load(value: PanelLayout) { preferences = value; render(); }, render, setMaximized,
    dispose() { finish(true); events.abort(); observer.disconnect(); } };
}
