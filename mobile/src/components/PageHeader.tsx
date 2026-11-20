import type { ReactNode } from 'react';

/**
 * Тонкий постоянный верхний бар шелла: держит статус-бар, «челку» и баннеры уведомлений
 * над контентом любой страницы. Высота строки — 48px плюс safe-area сверху, поэтому
 * страницы больше не наезжают под системную панель.
 */
export function PageHeader({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <header className="shrink-0 px-4 pt-[var(--safe-top,0px)]">
      <div className="flex h-12 items-center justify-between gap-2">
        {title ? (
          <span className="label-up truncate">{title}</span>
        ) : (
          <span aria-hidden="true" />
        )}
        {children}
      </div>
    </header>
  );
}

export default PageHeader;
