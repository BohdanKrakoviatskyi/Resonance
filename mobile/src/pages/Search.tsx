import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { IconButton, Loader, Segmented } from '../components/ui';
import { MobileTrackList } from '../components/TrackList';
import { useStore } from '../lib/util';
import { pick, t, useLang } from '../lib/i18n';
import { searchTracks } from '../lib/api';
import { ytMusicSearchSuggestions } from '../lib/providers-api';
import { MOODS } from '../lib/moods';
import { ui } from '../state/ui';
import type { Track } from '../types';

export default function Search() {
  useLang();
  const initialQ = useStore(ui, (s) => s.searchQ);
  const [query, setQuery] = useState(initialQ);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'youtube' | 'soundcloud'>('all');
  const [results, setResults] = useState<Track[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (initialQ && initialQ !== query) {
      setQuery(initialQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  useEffect(() => {
    const q = query.trim();
    ui.set({ searchQ: query });
    abortRef.current?.abort();
    if (!q) {
      setResults([]);
      setSuggestions([]);
      setLoading(false);
      setError('');
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError('');

    const timer = window.setTimeout(() => {
      void ytMusicSearchSuggestions(q, ac.signal)
        .then((s) => {
          if (!ac.signal.aborted) setSuggestions((s.queries ?? []).slice(0, 6));
        })
        .catch(() => {});

      void searchTracks(q, ac.signal)
        .then((items) => {
          if (!ac.signal.aborted) {
            setResults(items);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (ac.signal.aborted) return;
          setError(err instanceof Error ? err.message : t('loadError'));
          setLoading(false);
        });
    }, 280);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query]);

  const filtered = results.filter((tr) => (sourceFilter === 'all' ? true : tr.source === sourceFilter));

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-3">
      <div className="flex items-center gap-2 rounded-2xl bg-sc-high px-3.5 py-1.5">
        <Icon name="search" className="text-on-surface-variant" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="h-10 flex-1 bg-transparent text-base outline-none"
          autoFocus={!query}
        />
        {query && <IconButton icon="close" label="Clear" size="sm" tip={false} onClick={() => setQuery('')} />}
      </div>

      {suggestions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {suggestions.map((sug) => (
            <button
              key={sug}
              type="button"
              onClick={() => setQuery(sug)}
              className="shrink-0 rounded-full bg-sc px-3 py-1.5 text-xs font-semibold text-on-surface-variant"
            >
              {sug}
            </button>
          ))}
        </div>
      )}

      {query.trim() ? (
        <>
          <Segmented
            size="sm"
            value={sourceFilter}
            onChange={setSourceFilter}
            options={[
              { value: 'all', label: t('favoritesAll') },
              { value: 'youtube', label: 'YouTube' },
              { value: 'soundcloud', label: 'SoundCloud' },
            ]}
          />

          {loading ? (
            <div className="grid place-items-center py-14">
              <Loader />
            </div>
          ) : error ? (
            <div className="rounded-2xl bg-sc-low p-6 text-center text-sm text-error">{error}</div>
          ) : (
            <MobileTrackList tracks={filtered} emptyText={t('noResults')} />
          )}
        </>
      ) : (
        <section>
          <h2 className="headline mb-3 text-base">{t('browse')}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            {MOODS.map((m) => (
              <button
                key={m.q}
                type="button"
                onClick={() => setQuery(m.q)}
                className="sl flex items-center gap-3 rounded-2xl bg-sc-low p-3.5 text-left"
              >
                <Icon name={m.icon as never} className="text-primary" />
                <span className="truncate text-sm font-bold">{pick(m.ru, m.en)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
