import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchConfig, fetchRoomLightsState, postRoomLightsToggle } from './api';
import { useKioskToast } from './KioskToastContext';
import { useSystemVolume } from './SystemVolumeContext';
import { useVoiceTurn } from './VoiceTurnContext';
import { useBanter } from './useBanter';
import { BanterButton } from './ui/BanterButton';
import { IconLight, IconVolume } from './ui/deviceChromeIcons';

const ACCENT = '#BF5AF2';
const LONG_PRESS_MS = 500;
const VOLUME_IDLE_MS = 5000;

export function DeviceTopChrome() {
  const standby = useLocation().pathname === '/standby';
  const { voiceTurn, connecting, interactionsMuted, setInteractionsMuted } = useVoiceTurn();
  const banter = useBanter(standby);
  const { percent, muted, setPercent, setMuted, loading } = useSystemVolume();
  const { showToast } = useKioskToast();
  const interactionsMuteInFlight = useRef(false);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [roomBound, setRoomBound] = useState(false);
  const [roomLightsOn, setRoomLightsOn] = useState<boolean | null>(null);
  const [lightsBusy, setLightsBusy] = useState(false);

  const longPressTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const longPressConsumed = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const scheduleIdleCollapse = useCallback(() => {
    clearIdleTimer();
    if (!volumeExpanded) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setVolumeExpanded(false);
    }, VOLUME_IDLE_MS);
  }, [clearIdleTimer, volumeExpanded]);

  useEffect(() => {
    if (volumeExpanded) {
      scheduleIdleCollapse();
    } else {
      clearIdleTimer();
    }
    return clearIdleTimer;
  }, [volumeExpanded, scheduleIdleCollapse, clearIdleTimer]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const cfg = await fetchConfig();
        if (cancelled) return;
        const bound = Boolean((cfg.room_name || '').trim());
        setRoomBound(bound);
        if (!bound) {
          setRoomLightsOn(null);
          return;
        }
      } catch {
        if (!cancelled) {
          setRoomBound(false);
          setRoomLightsOn(null);
        }
        return;
      }

      // The configured room decides whether the control is available. A
      // transient state lookup failure must not make the light control vanish;
      // the button can still issue its deterministic room toggle request.
      try {
        const st = await fetchRoomLightsState();
        if (cancelled) return;
        setRoomLightsOn(st.is_on);
      } catch {
        if (!cancelled) {
          setRoomLightsOn(null);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const onVolumePointerDown = useCallback(() => {
    longPressConsumed.current = false;
    clearLongPressTimer();
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressConsumed.current = true;
      void setMuted(!muted).catch(() => {
        showToast("Couldn't change mute");
      });
    }, LONG_PRESS_MS);
  }, [clearLongPressTimer, muted, setMuted, showToast]);

  const onVolumePointerEnd = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  const onVolumeClick = useCallback(() => {
    if (longPressConsumed.current) {
      longPressConsumed.current = false;
      return;
    }
    setVolumeExpanded((v) => !v);
  }, []);

  const onInteractionsMuteToggle = useCallback(() => {
    if (interactionsMuteInFlight.current) return;
    interactionsMuteInFlight.current = true;
    void setInteractionsMuted(!interactionsMuted)
      .catch(() => {
        /* Toast already shown by VoiceTurnContext. */
      })
      .finally(() => {
        interactionsMuteInFlight.current = false;
      });
  }, [interactionsMuted, setInteractionsMuted]);

  const onToggleRoomLights = useCallback(() => {
    if (lightsBusy) return;
    setLightsBusy(true);
    void postRoomLightsToggle()
      .then(() => fetchRoomLightsState())
      .then((st) => setRoomLightsOn(st.is_on))
      .catch(() => {
        showToast("Couldn't toggle lights");
      })
      .finally(() => setLightsBusy(false));
  }, [lightsBusy, showToast]);

  const volLabel = muted
    ? 'Muted — tap to show system volume, long-press to unmute'
    : 'System volume — tap to adjust, long-press to mute';

  const bumpIdleOnInteract = useCallback(() => {
    scheduleIdleCollapse();
  }, [scheduleIdleCollapse]);

  return (
    <>
      {volumeExpanded ? (
        <div
          className="device-volume-expanded-bar"
          role="region"
          aria-label="System volume"
          onPointerDown={bumpIdleOnInteract}
          onPointerMove={bumpIdleOnInteract}
        >
          <div className="device-volume-expanded-inner">
            <span className="spotify-volume-label device-volume-expanded-label" aria-hidden>
              Vol
            </span>
            <input
              type="range"
              className="spotify-volume-slider kiosk-system-volume-slider device-volume-expanded-slider"
              min={0}
              max={100}
              step={1}
              value={percent}
              onChange={(e) => {
                setPercent(Number(e.target.value));
                bumpIdleOnInteract();
              }}
              onPointerDown={bumpIdleOnInteract}
              aria-label="System volume"
            />
          </div>
        </div>
      ) : null}

      {roomBound && !volumeExpanded ? (
        <div className="device-top-chrome-light">
          <button
            type="button"
            className={`device-top-chrome-icon-btn tap-target${roomLightsOn ? ' expanded' : ''}`}
            style={{ color: ACCENT }}
            aria-label="Toggle room lights"
            disabled={lightsBusy}
            onClick={onToggleRoomLights}
          >
            <IconLight on={Boolean(roomLightsOn)} />
          </button>
        </div>
      ) : null}

      {!volumeExpanded ? (
        <div className="device-top-chrome-volume">
          <BanterButton
            standby={standby}
            state={banter.state}
            pending={banter.pending}
            voiceActive={voiceTurn || connecting}
            interactionsMuted={interactionsMuted}
            onClick={banter.trigger}
            onMuteToggle={onInteractionsMuteToggle}
          />
          <button
            type="button"
            className="device-top-chrome-icon-btn tap-target"
            style={{ color: ACCENT }}
            aria-label={volLabel}
            aria-expanded={volumeExpanded}
            disabled={loading}
            onPointerDown={onVolumePointerDown}
            onPointerUp={onVolumePointerEnd}
            onPointerCancel={onVolumePointerEnd}
            onPointerLeave={onVolumePointerEnd}
            onClick={onVolumeClick}
          >
            <IconVolume muted={muted} />
          </button>
        </div>
      ) : null}
    </>
  );
}
