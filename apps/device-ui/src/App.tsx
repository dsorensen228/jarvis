import { Navigate, Route, Routes } from 'react-router-dom';
import { DeviceShell } from './DeviceShell';
import { KioskToastProvider } from './KioskToastContext';
import { TimerAlarmProvider } from './timer/TimerAlarmContext';
import { VoiceTurnProvider } from './VoiceTurnContext';
import { StandbyPage } from './pages/StandbyPage';
import { CamerasPage } from './pages/CamerasPage';
import { SpotifyLayout } from './pages/SpotifyLayout';
import { SpotifyNowPage } from './pages/SpotifyNowPage';
import { SpotifySearchPage } from './pages/SpotifySearchPage';
import { SpotifyQueuePage } from './pages/SpotifyQueuePage';
import { TimerAlarmsPage } from './pages/TimerAlarmsPage';
import { TvRemotePage } from './pages/TvRemotePage';
import { CodeTasksPage } from './pages/CodeTasksPage';

export default function App() {
  return (
    <KioskToastProvider>
      <VoiceTurnProvider>
        <TimerAlarmProvider>
          <DeviceShell>{(backgroundLocation, previewActive) => (
            <Routes location={backgroundLocation}>
              <Route path="/" element={<Navigate to="/standby" replace />} />
              <Route path="/standby" element={<StandbyPage />} />
              <Route path="/cameras" element={<CamerasPage suspended={previewActive} />} />
              <Route path="/cameras/:deviceId" element={<CamerasPage suspended={previewActive} />} />
              <Route path="/spotify" element={<SpotifyLayout />}>
                <Route index element={<SpotifyNowPage />} />
                <Route path="search" element={<SpotifySearchPage />} />
                <Route path="queue" element={<SpotifyQueuePage />} />
              </Route>
              <Route path="/timer" element={<TimerAlarmsPage />} />
              <Route path="/timer/alarms" element={<TimerAlarmsPage />} />
              <Route path="/tv" element={<TvRemotePage />} />
              <Route path="/code" element={<CodeTasksPage suspended={previewActive} />} />
              <Route path="*" element={<Navigate to="/standby" replace />} />
            </Routes>
          )}</DeviceShell>
        </TimerAlarmProvider>
      </VoiceTurnProvider>
    </KioskToastProvider>
  );
}
