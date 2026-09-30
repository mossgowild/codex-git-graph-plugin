import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

export function Tooltip({ locale }: { locale: string }) {
  const element = useRef<HTMLDivElement>(null);
  const refresh = useRef<() => void>(() => {});
  useLayoutEffect(() => { refresh.current(); }, [locale]);
  useEffect(() => {
    const tooltip = element.current!;
    let trigger: HTMLElement | null = null, openTimer = 0, closeTimer = 0, lastClose = -Infinity;
    const cancelClose = () => window.clearTimeout(closeTimer);
    const hide = () => {
      window.clearTimeout(openTimer); cancelClose();
      if (tooltip.matches(':popover-open')) { tooltip.hidePopover(); lastClose = performance.now(); }
      if (trigger) {
        const descriptions = trigger.getAttribute('aria-describedby')?.split(/\s+/).filter(id => id !== tooltip.id).join(' ');
        if (descriptions) trigger.setAttribute('aria-describedby', descriptions);
        else trigger.removeAttribute('aria-describedby');
      }
      trigger = null;
    };
    const canShow = (next: HTMLElement | null): next is HTMLElement => {
      if (!next?.dataset.tooltip || !next.isConnected || !next.getClientRects().length || next.closest('[hidden], [inert]') || next.matches(':disabled:not(select), select:open')) return false;
      const selector = next.getAttribute('data-tooltip-overflow');
      return selector === null || Array.from(selector ? next.querySelectorAll(selector) : [next])
        .some(content => content.scrollWidth > content.clientWidth || content.scrollHeight > content.clientHeight);
    };
    const position = () => {
      if (!trigger || !tooltip.matches(':popover-open')) return;
      if (!canShow(trigger)) { hide(); return; }
      const anchor = trigger.getBoundingClientRect();
      tooltip.style.maxHeight = '';
      let bounds = tooltip.getBoundingClientRect();
      const above = Math.max(0, anchor.top - 10), below = Math.max(0, innerHeight - anchor.bottom - 10);
      const onTop = bounds.height <= above || (bounds.height > below && above > below);
      tooltip.style.maxHeight = `${onTop ? above : below}px`;
      bounds = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, Math.min(anchor.left + (anchor.width - bounds.width) / 2, innerWidth - bounds.width - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(onTop ? anchor.top - bounds.height - 2 : anchor.bottom + 2, innerHeight - bounds.height - 8))}px`;
    };
    refresh.current = () => {
      if (!trigger) return;
      if (!canShow(trigger)) { hide(); return; }
      if (tooltip.matches(':popover-open')) { tooltip.textContent = trigger.dataset.tooltip!; position(); }
    };
    const target = (value: EventTarget | null) => value instanceof Element ? value.closest<HTMLElement>('[data-tooltip]') : null;
    const show = (next: HTMLElement | null, keyboard = false) => {
      if (!canShow(next)) return;
      if (next === trigger) { cancelClose(); return; }
      hide(); trigger = next;
      openTimer = window.setTimeout(() => {
        if (!canShow(next)) { hide(); return; }
        tooltip.textContent = next.dataset.tooltip!;
        next.setAttribute('aria-describedby', [next.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' '));
        tooltip.showPopover(); position();
      }, keyboard || performance.now() - lastClose < 300 ? 0 : 200);
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (tooltip.contains(event.target as Node)) { cancelClose(); return; }
      show(target(event.target));
    };
    const leave = (event: PointerEvent) => {
      if (!tooltip.contains(event.target as Node) && !trigger?.contains(event.target as Node)) return;
      const next = event.relatedTarget;
      if (next instanceof Node && (tooltip.contains(next) || trigger?.contains(next))) return;
      if (!tooltip.matches(':popover-open')) { hide(); return; }
      cancelClose(); closeTimer = window.setTimeout(hide, 100);
    };
    const focus = (event: FocusEvent) => {
      const next = target(event.target);
      if (next?.matches(':focus-visible')) show(next, true);
    };
    const blur = (event: FocusEvent) => {
      if (!trigger?.contains(event.target as Node)) return;
      if (!(event.relatedTarget instanceof Node) || !trigger?.contains(event.relatedTarget)) hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    const observer = new ResizeObserver(position);
    observer.observe(tooltip);
    document.addEventListener('pointerover', enter);
    document.addEventListener('pointerout', leave);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('click', hide);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    window.addEventListener('blur', hide);
    return () => {
      refresh.current = () => {};
      observer.disconnect();
      hide();
      document.removeEventListener('pointerover', enter);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('click', hide);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('blur', hide);
    };
  }, []);
  return <div id="codex-tooltip" ref={element} class="codex-tooltip" role="tooltip" popover="manual" />;
}
