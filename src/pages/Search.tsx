import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, EmptyState, IconButton, Loader, Section, type Vars } from '../components/ui';
import { SkeletonRows, TrackList } from '../components/TrackList';
import { useStore } from '../lib/util';
import { pick, t } from '../lib/i18n';
import { hct } from '../lib/color';
import { searchTracks } from '../lib/api';
import { MOODS } from '../lib/moods';
import { registerTracks, searchLocal } from '../state/library';
import { theme } from '../state/theme';
import { go } from '../state/ui';
import type { Track } from '../types';

const cache = new Map<string, Track[]>();

function useRemote(q: string) {
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

function Browse() {
  const dark = useStore(theme, (s) => s.dark);
  return (
    <Section title={t('browse')}>
      <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-4 @6xl:grid-cols-5">
        {MOODS.map((m, i) => (
          <button
            key={m.q}
            type="button"
            data-ripple
            className="browse-card sl anim-in"
            style={{ '--i': i, background: hct(m.hue, 46, dark ? 32 : 82), color: hct(m.hue, 24, dark ? 94 : 16) } as Vars}
            onClick={() => go({ name: 'search', q: m.q })}
          >
            <span className="headline relative z-[1] text-lg">{pick(m.ru, m.en)}</span>
            <Icon name={m.icon} fill className="browse-icon" />
          </button>
        ))}
      </div>
    </Section>
  );
}

export default function Search({ q }: { q: string }) {
  const [text, setText] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, []);
  useEffect(() => {
    setText((cur) => (cur.trim() === q ? cur : q));
  }, [q]);
  useEffect(() => {
    const tm = setTimeout(() => text.trim() !== q && go({ name: 'search', q: text.trim() }, true), 320);
    return () => clearTimeout(tm);
  }, [text, q]);

  const remote = useRemote(q);
  const local = useMemo(() => (q ? searchLocal(q) : []), [q]);
  const nothing = q && !local.length && remote.items?.length === 0 && !remote.error;

  return (
    <div className="page">
      <div className="search-wrap anim-in">
        <label className="search-bar">
          <Icon name="search" className="text-on-surface-variant" />
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('search')}
            onKeyDown={(e) => e.key === 'Escape' && setText('')}
            enterKeyHint="search"
          />
          {remote.loading && <Loader size={26} />}
          {text && (
            <IconButton
              icon="close"
              label={t('cancel')}
              tip={false}
              onClick={() => {
                setText('');
                input.current?.focus();
              }}
            />
          )}
        </label>
      </div>
      {!q ? (
        <Browse />
      ) : nothing ? (
        <EmptyState icon="search_off" title={t('noResults')} text={t('noResultsText')} />
      ) : (
        <div key={q}>
          {local.length > 0 && (
            <Section title={t('inLibrary')} i={0}>
              <TrackList ids={local} />
            </Section>
          )}
          <Results title={t('soundcloudTracks')} r={remote} i={1} />
        </div>
      )}
    </div>
  );
}
