import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Segmented, Slider } from './ui';
import { Cover } from './Cover';
import { LikeButton, SourcePill } from './TrackList';
import { cx, fmtTime, useStore } from '../lib/util';
import { t, useLang } from '../lib/i18n';
import { getLyrics, type LyricsData } from '../lib/api';
import { getTrack } from '../state/library';
import {
  cycleRepeat,
  next,
  player,
  prev,
  seek,
  skipToIndex,
  toggle,
  toggleShuffle,
  useCurrentTrack,
} from '../state/player';
import { openSearch, openTrackMenu, ui } from '../state/ui';

function MobileLyricsPane({ trackId }: { trackId: string }) {
  const track = getTrack(trackId);
  const pos = useStore(player, (s) => s.pos);
  const [lyrics, setLyrics] = useState<LyricsData | null | 'loading'>('loading');
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!track) return;
    setLyrics('loading');
    void getLyrics(track).then((res) => {
      if (!cancelled) setLyrics(res);
    });
    return () => {
      cancelled = true;
    };
  }, [trackId, track]);

  const synced = lyrics && lyrics !== 'loading' ? lyrics.synced : undefined;
  let activeIdx = -1;
  if (synced) {
    for (let i = 0; i < synced.length; i++) {
      if (synced[i].t <= pos + 0.15) activeIdx = i;
      else break;
    }
  }

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeIdx]);

  if (lyrics === 'loading') {
    return (
      <div className="grid flex-1 place-items-center text-sm text-on-surface-variant">
        {t('lyricsLoading')}
      </div>
    );
  }

  if (!lyrics || (!lyrics.synced?.length && !lyrics.plain?.length)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-on-surface-variant">
        <Icon name="lyrics" size={38} className="opacity-45" />
        <p className="text-sm">{lyrics?.instrumental ? 'Instrumental' : t('noLyrics')}</p>
      </div>
    );
  }

  if (synced && synced.length > 0) {
    return (
      <div className="flex-1 overflow-y-auto px-5 py-6">
        <div className="flex flex-col gap-4 pb-16">
          {synced.map((line, idx) => {
            const isActive = idx === activeIdx;
            return (
              <button
                key={`${idx}-${line.t}`}
                ref={isActive ? activeRef : undefined}
                type="button"
                onClick={() => void seek(line.t)}
                className={cx(
                  'text-left text-[21px] font-extrabold leading-snug transition-all duration-300',
                  isActive ? 'scale-[1.02] text-on-surface opacity-100' : 'text-on-surface-variant opacity-40',
                )}
              >
                {line.gap ? '• • •' : line.text}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-6">
      <div className="flex flex-col gap-3 pb-12 text-[17px] font-semibold leading-relaxed text-on-surface/90">
        {lyrics.plain?.map((line, i) => (
          <p key={i} className="m-0">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

export function NowPlayingSheet() {
  const open = useStore(ui, (s) => s.nowPlayingOpen);
  const tab = useStore(ui, (s) => s.nowPlayingTab);
  const track = useCurrentTrack();
  const playing = useStore(player, (s) => s.playing);
  const loading = useStore(player, (s) => s.loading);
  const pos = useStore(player, (s) => s.pos);
  const duration = useStore(player, (s) => s.duration);
  const shuffle = useStore(player, (s) => s.shuffle);
  const repeat = useStore(player, (s) => s.repeat);
  const queue = useStore(player, (s) => s.queue);
  const curIndex = useStore(player, (s) => s.index);
  const eqEnabled = useStore(player, (s) => s.eqEnabled);
  const lang = useLang();

  if (!open || !track) return null;

  const totalSec = duration > 0 ? duration : track.duration || 1;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface/95 backdrop-blur-2xl">
      <header className="flex items-center justify-between px-4 pb-2 pt-[calc(env(safe-area-inset-top,0px)+10px)]">
        <IconButton
          icon="expand_more"
          label="Minimize"
          variant="tonal"
          tip={false}
          onClick={() => ui.set({ nowPlayingOpen: false })}
        />

        <Segmented
          size="sm"
          value={tab}
          onChange={(v) => ui.set({ nowPlayingTab: v })}
          options={[
            { value: 'artwork', label: lang === 'en' ? 'Track' : 'Трек' },
            { value: 'lyrics', label: t('lyrics') },
            { value: 'queue', label: t('upNext') },
          ]}
        />

        <div className="flex items-center gap-1">
          <IconButton
            icon="equalizer"
            label="Equalizer"
            variant={eqEnabled ? 'filled' : 'tonal'}
            selected={eqEnabled}
            tip={false}
            onClick={() => ui.set({ eqSheetOpen: true })}
          />
          <IconButton
            icon="more_vert"
            label="Actions"
            tip={false}
            onClick={() => openTrackMenu(track.id)}
          />
        </div>
      </header>

      {tab === 'artwork' && (
        <div className="flex min-h-0 flex-1 flex-col justify-between px-6 pb-[calc(env(safe-area-inset-bottom,0px)+22px)] pt-3">
          <div className="my-auto flex flex-col items-center">
            <Cover
              src={track.cover || track.thumb}
              className="aspect-square w-full max-w-[330px] rounded-[32px] shadow-2xl"
            />
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="headline truncate text-2xl font-extrabold">{track.title}</h1>
                <button
                  type="button"
                  onClick={() => openSearch(track.artist)}
                  className="mt-1 flex max-w-full items-center gap-2 text-left text-[15px] text-on-surface-variant"
                >
                  <SourcePill track={track} />
                  <span className="truncate">{track.artist}</span>
                </button>
              </div>
              <LikeButton id={track.id} />
            </div>

            <div className="mt-5">
              <Slider
                value={Math.min(pos, totalSec)}
                min={0}
                max={totalSec}
                label="Seek"
                onChange={(v) => void seek(v)}
              />
              <div className="mt-1 flex justify-between text-xs font-semibold tabular-nums text-on-surface-variant">
                <span>{fmtTime(pos)}</span>
                <span>{fmtTime(totalSec)}</span>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between px-2">
              <IconButton
                icon="shuffle"
                label={t('shuffle')}
                toggle
                selected={shuffle}
                tip={false}
                onClick={() => void toggleShuffle()}
              />
              <IconButton
                icon="skip_previous"
                label={t('previous')}
                size="lg"
                tip={false}
                onClick={() => void prev()}
              />
              <button
                type="button"
                aria-label={playing ? t('pause') : t('play')}
                onClick={toggle}
                className="sl grid h-[72px] w-[72px] place-items-center rounded-[26px] bg-primary text-on-primary shadow-lg active:scale-95"
              >
                <Icon name={loading ? 'graphic_eq' : playing ? 'pause' : 'play_arrow'} fill size={36} />
              </button>
              <IconButton
                icon="skip_next"
                label={t('next')}
                size="lg"
                tip={false}
                onClick={() => void next()}
              />
              <IconButton
                icon={repeat === 'one' ? 'repeat_one' : 'repeat'}
                label={t('repeat')}
                toggle
                selected={repeat !== 'off'}
                tip={false}
                onClick={() => void cycleRepeat()}
              />
            </div>
          </div>
        </div>
      )}

      {tab === 'lyrics' && (
        <div className="flex min-h-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
          <MobileLyricsPane trackId={track.id} />
          <div className="flex items-center justify-center gap-5 border-t border-outline-variant/30 px-6 pt-3">
            <IconButton icon="skip_previous" label="Previous" tip={false} onClick={() => void prev()} />
            <button
              type="button"
              onClick={toggle}
              className="sl grid h-14 w-14 place-items-center rounded-2xl bg-primary text-on-primary"
            >
              <Icon name={playing ? 'pause' : 'play_arrow'} fill size={28} />
            </button>
            <IconButton icon="skip_next" label="Next" tip={false} onClick={() => void next()} />
          </div>
        </div>
      )}

      {tab === 'queue' && (
        <div className="flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-2">
          <div className="mb-2 px-2 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
            {t('upNext')} · {queue.length}
          </div>
          <div className="flex flex-col gap-1">
            {queue.map((id, idx) => {
              const item = getTrack(id);
              if (!item) return null;
              const isCur = idx === curIndex;
              return (
                <button
                  key={`${id}-${idx}`}
                  type="button"
                  onClick={() => void skipToIndex(idx)}
                  className={cx(
                    'sl flex items-center gap-3 rounded-2xl px-3 py-2 text-left',
                    isCur ? 'bg-primary-container/60 text-on-primary-container' : '',
                  )}
                >
                  <Cover src={item.thumb || item.cover} className="h-11 w-11 shrink-0 rounded-xl" />
                  <div className="min-w-0 flex-1">
                    <div className={cx('truncate text-sm font-bold', isCur && 'text-primary')}>{item.title}</div>
                    <div className="truncate text-xs text-on-surface-variant">{item.artist}</div>
                  </div>
                  <span className="text-xs tabular-nums text-on-surface-variant">{fmtTime(item.duration)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
