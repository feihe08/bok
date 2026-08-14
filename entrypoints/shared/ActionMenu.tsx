import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

export type ActionMenuEntry =
  | {
      type: 'action';
      id: string;
      label: string;
      tone?: 'default' | 'danger';
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator'; id: string };

interface ActionMenuProps {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  disabled?: boolean;
  pending?: boolean;
  entries: ActionMenuEntry[];
}

interface MenuPosition {
  top: number;
  left: number;
  maxHeight: number;
  ready: boolean;
}

const VIEWPORT_PADDING = 8;
const MENU_GAP = 4;

export function ActionMenu({
  ref,
  label,
  disabled = false,
  pending = false,
  entries,
}: ActionMenuProps) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<MenuPosition>({
      top: 0,
      left: 0,
      maxHeight: 0,
      ready: false,
    });
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuId = useId();

    const close = useCallback((restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) {
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }, []);

    const updatePosition = useCallback(() => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const spaceBelow = window.innerHeight - triggerRect.bottom - MENU_GAP - VIEWPORT_PADDING;
      const spaceAbove = triggerRect.top - MENU_GAP - VIEWPORT_PADDING;
      const placeBelow = spaceBelow >= Math.min(menu.scrollHeight, 240) || spaceBelow >= spaceAbove;
      const maxHeight = Math.max(0, placeBelow ? spaceBelow : spaceAbove);
      const renderedHeight = Math.min(menu.scrollHeight, maxHeight);
      const top = placeBelow
        ? triggerRect.bottom + MENU_GAP
        : triggerRect.top - renderedHeight - MENU_GAP;
      const left = Math.min(
        window.innerWidth - menuRect.width - VIEWPORT_PADDING,
        Math.max(VIEWPORT_PADDING, triggerRect.right - menuRect.width),
      );

      setPosition({
        top: Math.max(VIEWPORT_PADDING, top),
        left,
        maxHeight,
        ready: true,
      });
    }, []);

    useLayoutEffect(() => {
      if (!open) return;
      updatePosition();
      const frame = requestAnimationFrame(() => {
        updatePosition();
        menuRef.current
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
          ?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }, [open, updatePosition]);

    useEffect(() => {
      if (!open) return;

      function handleOutsidePress(event: PointerEvent) {
        const target = event.target as Node;
        if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
        close(false);
      }

      function handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }

      document.addEventListener('pointerdown', handleOutsidePress);
      document.addEventListener('keydown', handleKeyDown);
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);

      return () => {
        document.removeEventListener('pointerdown', handleOutsidePress);
        document.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
      };
    }, [close, open, updatePosition]);

    function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

      const items = [
        ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ),
      ];
      if (items.length === 0) return;

      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (currentIndex + 1 + items.length) % items.length
              : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    }

    function setTriggerRef(node: HTMLButtonElement | null) {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }

    return (
      <>
        <button
          ref={setTriggerRef}
          type="button"
          className="action-menu__trigger"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">{pending ? '…' : '•••'}</span>
        </button>
        {open &&
          createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="action-menu"
              role="menu"
              aria-label={label}
              style={{
                top: position.top,
                left: position.left,
                maxHeight: position.maxHeight,
                visibility: position.ready ? 'visible' : 'hidden',
              }}
              onKeyDown={handleMenuKeyDown}
            >
              {entries.map((entry) =>
                entry.type === 'separator' ? (
                  <div key={entry.id} className="action-menu__separator" role="separator" />
                ) : (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitem"
                    className="action-menu__item"
                    data-tone={entry.tone}
                    disabled={entry.disabled}
                    onClick={() => {
                      close(false);
                      entry.onSelect();
                    }}
                  >
                    {entry.label}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )}
      </>
    );
}
