import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, EmptyState, Section } from '../components/ui';
import { SkeletonRows, TrackList } from '../components/TrackList';
import { t } from '../lib/i18n';
import { searchTracks } from '../lib/api';
import { registerTracks, searchLocal } from '../state/library';
import type { Track } from '../types';

const cache = new Map<string, Track[]>();

export function useRemote(q: string) {
  const key = q.toLowerCase();
  const [st, setSt] = useState<{ key: string; items: Track[] | null; error: boolean }>({ key: '', items: null, error: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!q) return;
    const hit = cache.get(key);
    if (hit) {
      setSt({ key, items: hit, error: false });
      return;
    }
    setSt({ key, items: null, error: false });
    const ac = new AbortController();
    searchTracks(q, ac.signal)
      .then((r) => {
        registerTracks(r);
        cache.set(key, r);
        setSt({ key, items: r, error: false });
      })
      .catch((e: Error) => e.name !== 'AbortError' && setSt({ key, items: [], error: true }));
    return () => ac.abort();
  }, [key, q, retry]);
  const fresh = st.key === key;
  return { items: fresh ? st.items : null, error: fresh && st.error, loading: !!q && (!fresh || st.items === null), retry: () => setRetry((r) => r + 1) };
}

function Results({ title, r, i }: { title: string; r: ReturnType<typeof useRemote>; i: number }) {
  const [all, setAll] = useState(false);
  const ids = useMemo(() => (r.items ?? []).map((x) => x.id), [r.items]);
  if (r.items && !r.items.length && !r.error) return null;
  return (
    <Section
      title={title}
      i={i}
      action={
        ids.length > 8 ? (
          <Button variant="text" onClick={() => setAll((a) => !a)}>
            {all ? t('showLess') : t('showAll')}
          </Button>
        ) : undefined
      }
    >
      {r.error ? (
        <div className="card flex items-center gap-4">
          <Icon name="error" className="text-error" />
          <span className="flex-1 text-on-surface-variant">{t('loadError')}</span>
          <Button variant="tonal" icon="refresh" onClick={r.retry}>
            {t('retry')}
          </Button>
        </div>
      ) : r.items ? (
        <TrackList ids={all ? ids : ids.slice(0, 8)} />
      ) : (
        <SkeletonRows />
      )}
    </Section>
  );
}

/** Inline search results — no search bar, no moods/browse. Rendered inside Home instead of home content. */
export function SearchResults({ q, loading: externalLoading }: { q: string; loading?: boolean }) {
  const remote = useRemote(q);
  const local = useMemo(() => (q ? searchLocal(q) : []), [q]);
  const nothing = q && !local.length && remote.items?.length === 0 && !remote.error;
  const loading = externalLoading ?? remote.loading;

  if (!q) {
    return (
      <EmptyState icon="search" title={t('searchPlaceholder')} text={t('noResultsText')} />
    );
  }
  if (nothing && !loading) {
    return <EmptyState icon="search_off" title={t('noResults')} text={t('noResultsText')} />;
  }
  return (
    <div key={q}>
      {local.length > 0 && (
        <Section title={t('inLibrary')} i={0}>
          <TrackList ids={local} />
        </Section>
      )}
      <Results title={t('soundcloudTracks')} r={remote} i={1} />
    </div>
  );
}
