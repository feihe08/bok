import type { ChangeEventHandler, Ref } from 'react';
import './app-header.css';

export type AppSection = 'saved' | 'reading-list' | 'bookmarks';

export interface AppHeaderSearch {
  label: string;
  placeholder: string;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  inputRef?: Ref<HTMLInputElement>;
  ariaKeyShortcuts?: string;
  disabled?: boolean;
}

export interface AppHeaderProps {
  activeSection: AppSection;
  search: AppHeaderSearch;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

const navigation: ReadonlyArray<{
  section: AppSection;
  href: string;
  label: string;
}> = [
  { section: 'saved', href: '/saved.html', label: '已保存网页' },
  { section: 'reading-list', href: '/reading-list.html', label: '好文' },
  { section: 'bookmarks', href: '/bookmark-manager.html', label: '书签管理' },
];

function NavigationIcon({ section }: { section: AppSection }) {
  if (section === 'saved') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M5.25 3.5h8.25a2 2 0 0 1 2 2v.25" />
        <rect x="3.5" y="5.75" width="13" height="10.75" rx="2" />
        <path d="M3.5 8.75h13M6.25 7.25h.01" />
      </svg>
    );
  }

  if (section === 'reading-list') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M3 4.25h3.05A3.95 3.95 0 0 1 10 8.2v7.55a3.95 3.95 0 0 0-3.95-3.95H3V4.25Z" />
        <path d="M17 4.25h-3.05A3.95 3.95 0 0 0 10 8.2v7.55a3.95 3.95 0 0 1 3.95-3.95H17V4.25Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M2.75 5.25h5l1.5 1.5h8v8.5a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
      <path d="M7 9.25v4M7 11.25h3.25M10.25 10v2.5M7 13.25h3.25" />
    </svg>
  );
}

export function AppHeader({
  activeSection,
  search,
  theme,
  onToggleTheme,
}: AppHeaderProps) {
  const themeActionLabel = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <a className="app-brand" href="/saved.html" aria-label="Bok 首页">
          <img src="/bok.svg" alt="" width="28" height="28" />
          <span>Bok</span>
        </a>

        <label className="app-search">
          <span className="app-sr-only">{search.label}</span>
          <svg className="app-search__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m12.5 12.5 4 4" />
          </svg>
          <input
            ref={search.inputRef}
            type="search"
            name="search"
            value={search.value}
            placeholder={search.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-keyshortcuts={search.ariaKeyShortcuts}
            disabled={search.disabled}
            onChange={search.onChange}
          />
        </label>

        <nav className="app-primary-nav" aria-label="主要导航">
          {navigation.map((item) => (
            <a
              key={item.section}
              href={item.href}
              aria-label={item.label}
              title={item.label}
              aria-current={item.section === activeSection ? 'page' : undefined}
            >
              <NavigationIcon section={item.section} />
            </a>
          ))}
        </nav>

        <div className="app-header__actions">
          <a className="app-utility-link" href="/options.html" aria-label="设置" title="设置">
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M10 2.75 11.2 4.2l1.85.42 1.58-1.05 1.4 1.4-1.05 1.58.42 1.85L17.25 10l-1.45 1.2-.42 1.85 1.05 1.58-1.4 1.4-1.58-1.05-1.85.42L10 17.25l-1.2-1.45-1.85-.42-1.58 1.05-1.4-1.4 1.05-1.58-.42-1.85L2.75 10 4.2 8.8l.42-1.85L3.57 5.37l1.4-1.4 1.58 1.05 1.85-.42L10 2.75Z" />
              <circle cx="10" cy="10" r="2.25" />
            </svg>
          </a>
          <button
            type="button"
            className="app-theme-toggle"
            data-theme={theme}
            aria-label={themeActionLabel}
            title={themeActionLabel}
            onClick={onToggleTheme}
          >
            <span className="app-theme-toggle__glyph" aria-hidden="true">
              <svg className="app-theme-toggle__moon" viewBox="0 0 20 20" focusable="false">
                <path d="M16.5 12.2A6.6 6.6 0 0 1 7.8 3.5a6.6 6.6 0 1 0 8.7 8.7Z" />
              </svg>
              <svg className="app-theme-toggle__sun" viewBox="0 0 20 20" focusable="false">
                <circle cx="10" cy="10" r="3.25" />
                <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l1.4 1.4" />
              </svg>
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
