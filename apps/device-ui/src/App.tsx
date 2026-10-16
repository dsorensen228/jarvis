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
import { TimerAlarmsPage } from './pages/TimerAlarmsPage';
import { TvRemotePage } from './pages/TvRemotePage';
import { CodeTasksPage } from './pages/CodeTasksPage';

export default function App() {
  return (
    <KioskToastProvider>
      <VoiceTurnProvider>
        <TimerAlarmProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/standby" replace />} />
            <Route element={<DeviceShell />}>
              <Route path="/standby" element={<StandbyPage />} />
              <Route path="/cameras" element={<CamerasPage />} />
              <Route path="/cameras/:deviceId" element={<CamerasPage />} />
              <Route path="/spotify" element={<SpotifyLayout />}>
                <Route index element={<SpotifyNowPage />} />
                <Route path="search" element={<SpotifySearchPage />} />
              </Route>
              <Route path="/timer" element={<TimerAlarmsPage />} />
              <Route path="/timer/alarms" element={<TimerAlarmsPage />} />
              <Route path="/tv" element={<TvRemotePage />} />
              <Route path="/code" element={<CodeTasksPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/standby" replace />} />
          </Routes>
        </TimerAlarmProvider>
      </VoiceTurnProvider>
    </KioskToastProvider>
  );
}
