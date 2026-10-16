import {
  getJarvisDevices,
  getMe,
  getRooms,
  getSmartDevices,
  getSmartHomeStatus,
  getUsersDirectory,
  setSmartDevicePower,
  syncSmartHome,
} from '@/lib/api-client';
import type {
  JarvisDevice,
  Room,
  SmartDevice,
  SmartHomeStatus,
  UserDirectoryEntry,
} from '@/lib/api-client/types';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useWindowDimensions } from 'react-native';

import { useAuth } from './AuthContext';
import {
  anyLightOn,
  anyLightPowerUnknown,
  applyPowerOp,
  collectPowerOps,
  hasScreen,
  isOutletOrOtherDevice,
} from '@/components/smartHome/lightHelpers';

type RoomBucket = {
  roomKey: string;
  lights: SmartDevice[];
  /** Plugs and other powered devices excluded from bulk lights. */
  others: SmartDevice[];
  displays: SmartDevice[];
};

type SmartHomeContextValue = {
  loadSmartControls: () => Promise<void>;
  jarvisDevices: JarvisDevice[];
  /** Every imported device, whatever it is. */
  smartDevices: SmartDevice[];
  /** Devices that take part in light control. */
  lights: SmartDevice[];
  /** Devices with a screen, for the TV remote. */
  displays: SmartDevice[];
  rooms: Room[];
  status: SmartHomeStatus | null;
  userDirectory: UserDirectoryEntry[];
  syncingDevices: boolean;
  syncError: string;
  deviceCommandError: string;
  reportDeviceCommandError: (message: string) => void;
  tileGridInnerWidth: number;
  setTileGridInnerWidth: (w: number) => void;
  tileWidth: number;
  lightsByRoom: Map<string, SmartDevice[]>;
  smartDevicesByRoom: RoomBucket[];
  bulkLightsBusyKey: string | null;
  handleSync: () => Promise<void>;
  toggleDevicePower: (device: SmartDevice, componentKey?: string) => Promise<void>;
  toggleLightsBucket: (lights: SmartDevice[], busyKey: string) => Promise<void>;
};

const SmartHomeContext = createContext<SmartHomeContextValue | null>(null);

export function SmartHomeProvider({ children }: { children: React.ReactNode }) {
  const { refreshUser } = useAuth();
  const { width: screenWidth } = useWindowDimensions();

  const [jarvisDevices, setJarvisDevices] = useState<JarvisDevice[]>([]);
  const [smartDevices, setSmartDevices] = useState<SmartDevice[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [status, setStatus] = useState<SmartHomeStatus | null>(null);
  const [userDirectory, setUserDirectory] = useState<UserDirectoryEntry[]>([]);
  const [syncingDevices, setSyncingDevices] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [deviceCommandError, setDeviceCommandError] = useState('');
  const reportDeviceCommandError = useCallback((message: string) => {
    setDeviceCommandError(message);
  }, []);
  const [bulkLightsBusyKey, setBulkLightsBusyKey] = useState<string | null>(null);
  const bulkLightsInFlight = useRef(false);
  /** When room power is unknown: alternate off → on; reset when state becomes known or toggle errors. */
  const unknownLightsBucketTapPhase = useRef<Map<string, 0 | 1>>(new Map());
  const [tileGridInnerWidth, setTileGridInnerWidth] = useState(0);

  const loadSmartControls = useCallback(async () => {
    const [deviceRows, roomRows, jarvisRows, dirRows, statusRow] = await Promise.all([
      getSmartDevices().catch(() => []),
      getRooms().catch(() => []),
      getJarvisDevices().catch(() => []),
      getUsersDirectory().catch(() => []),
      getSmartHomeStatus().catch(() => null),
    ]);
    setSmartDevices(deviceRows);
    setRooms(roomRows);
    setJarvisDevices(jarvisRows);
    setUserDirectory(dirRows);
    setStatus(statusRow);
  }, []);

  useEffect(() => {
    void loadSmartControls();
  }, [loadSmartControls]);

  const tileWidth = useMemo(() => {
    const gap = 12;
    const minPair = 220;
    const fallback = Math.max(0, screenWidth - 88);
    const w = tileGridInnerWidth > 8 ? tileGridInnerWidth : fallback;
    if (w >= minPair) {
      return Math.floor((w - gap) / 2);
    }
    return Math.floor(w);
  }, [tileGridInnerWidth, screenWidth]);

  const lights = useMemo(
    () => smartDevices.filter((device) => device.is_light),
    [smartDevices]
  );

  const displays = useMemo(
    () =>
      smartDevices.filter((device) =>
        device.components.some((component) => component.domain === 'media_player')
      ),
    [smartDevices]
  );

  const lightsByRoom = useMemo(() => {
    const map = new Map<string, SmartDevice[]>();
    for (const device of lights) {
      const room = device.room.trim();
      if (!room) continue;
      const existing = map.get(room);
      if (existing) existing.push(device);
      else map.set(room, [device]);
    }
    return map;
  }, [lights]);

  const smartDevicesByRoom = useMemo(() => {
    const grouped = new Map<string, RoomBucket>();
    const ensure = (key: string): RoomBucket => {
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = { roomKey: key, lights: [], others: [], displays: [] };
        grouped.set(key, bucket);
      }
      return bucket;
    };
    for (const device of smartDevices) {
      const key = device.room.trim() || 'Unassigned';
      const bucket = ensure(key);
      if (device.is_light) bucket.lights.push(device);
      else if (isOutletOrOtherDevice(device)) bucket.others.push(device);
      if (hasScreen(device)) bucket.displays.push(device);
    }
    return Array.from(grouped.values()).sort((a, b) => a.roomKey.localeCompare(b.roomKey));
  }, [smartDevices]);

  const handleSync = useCallback(async () => {
    setSyncingDevices(true);
    setSyncError('');
    try {
      setSmartDevices(await syncSmartHome());
      const [me] = await Promise.all([getMe().catch(() => null), loadSmartControls()]);
      if (me) refreshUser(me);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not reach Home Assistant.');
    } finally {
      setSyncingDevices(false);
    }
  }, [loadSmartControls, refreshUser]);

  const toggleDevicePower = useCallback(
    async (device: SmartDevice, componentKey?: string) => {
      const component = componentKey
        ? device.components.find((entry) => entry.key === componentKey)
        : undefined;
      const previous = componentKey ? (component?.power ?? null) : device.power;
      const next = previous !== true;
      setDeviceCommandError('');
      setSmartDevices((rows) => applyPowerOp(rows, device.id, next, componentKey));
      try {
        await setSmartDevicePower(device.id, next, componentKey);
        await loadSmartControls();
      } catch (error) {
        setDeviceCommandError(
          error instanceof Error ? error.message : 'Could not change device power.'
        );
        setSmartDevices((rows) => applyPowerOp(rows, device.id, previous === true, componentKey));
        await loadSmartControls();
      }
    },
    [loadSmartControls]
  );

  const toggleLightsBucket = useCallback(
    async (bucket: SmartDevice[], busyKey: string) => {
      if (bucket.length === 0 || bulkLightsInFlight.current) return;
      const someOn = anyLightOn(bucket);
      const hasUnknown = anyLightPowerUnknown(bucket);
      let targetOn: boolean;
      if (someOn) {
        targetOn = false;
        unknownLightsBucketTapPhase.current.delete(busyKey);
      } else if (hasUnknown) {
        targetOn = (unknownLightsBucketTapPhase.current.get(busyKey) ?? 0) === 1;
      } else {
        targetOn = true;
        unknownLightsBucketTapPhase.current.delete(busyKey);
      }
      const ops = collectPowerOps(bucket, targetOn);
      if (ops.length === 0) return;
      bulkLightsInFlight.current = true;
      setBulkLightsBusyKey(busyKey);
      setSmartDevices((rows) => {
        let next = rows;
        for (const op of ops) {
          next = applyPowerOp(next, op.id, targetOn, op.component);
        }
        return next;
      });
      try {
        await Promise.all(ops.map((op) => setSmartDevicePower(op.id, targetOn, op.component)));
        if (!someOn && hasUnknown) {
          const phase = unknownLightsBucketTapPhase.current.get(busyKey) ?? 0;
          unknownLightsBucketTapPhase.current.set(busyKey, phase === 0 ? 1 : 0);
        }
      } catch {
        unknownLightsBucketTapPhase.current.delete(busyKey);
        await loadSmartControls();
      } finally {
        bulkLightsInFlight.current = false;
        setBulkLightsBusyKey(null);
      }
    },
    [loadSmartControls]
  );

  const value = useMemo(
    () => ({
      loadSmartControls,
      jarvisDevices,
      smartDevices,
      lights,
      displays,
      rooms,
      status,
      userDirectory,
      syncingDevices,
      syncError,
      deviceCommandError,
      reportDeviceCommandError,
      tileGridInnerWidth,
      setTileGridInnerWidth,
      tileWidth,
      lightsByRoom,
      smartDevicesByRoom,
      bulkLightsBusyKey,
      handleSync,
      toggleDevicePower,
      toggleLightsBucket,
    }),
    [
      loadSmartControls,
      jarvisDevices,
      smartDevices,
      lights,
      displays,
      rooms,
      status,
      userDirectory,
      syncingDevices,
      syncError,
      deviceCommandError,
      reportDeviceCommandError,
      tileGridInnerWidth,
      tileWidth,
      lightsByRoom,
      smartDevicesByRoom,
      bulkLightsBusyKey,
      handleSync,
      toggleDevicePower,
      toggleLightsBucket,
    ]
  );

  return <SmartHomeContext.Provider value={value}>{children}</SmartHomeContext.Provider>;
}

export function useSmartHome() {
  const ctx = useContext(SmartHomeContext);
  if (!ctx) {
    throw new Error('useSmartHome must be used within SmartHomeProvider');
  }
  return ctx;
}
