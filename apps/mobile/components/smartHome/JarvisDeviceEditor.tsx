import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';

import { Field, PickerField } from '@/components/settings/FormFields';
import type { JarvisDevice, JarvisDeviceType, Room, UserDirectoryEntry } from '@/lib/api-client/types';

import { smartHomeStyles as styles } from './smartHomeStyles';

export type JarvisDeviceSaveBody = {
  device_name?: string;
  address?: string;
  callback_port?: number | null;
  room?: string | null;
  device_type?: JarvisDeviceType;
  acting_user_id?: string | null;
  doorbell_alerts_enabled?: boolean;
  callback_secret?: string | null;
  describe_scene_prompt?: string | null;
  is_main_describe_camera?: boolean;
};

export function JarvisDeviceTile({
  device,
  rooms,
  colors,
  tileStyle,
  onPress,
}: {
  device: JarvisDevice;
  rooms: Room[];
  colors: {
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
  };
  tileStyle?: { width?: number };
  onPress: () => void;
}) {
  const deviceType = device.device_type || 'voice_interface';
  const roomLabel = device.room?.trim() || 'No room';

  return (
    <TouchableOpacity
      style={[
        styles.jarvisDeviceGridTile,
        tileStyle,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.jarvisTypeRow}>
        <Text style={[styles.deviceTileTitle, { color: colors.text }]} numberOfLines={2}>
          {device.device_name}
        </Text>
        <View
          style={[
            styles.typeBadge,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          <Text style={[styles.typeBadgeText, { color: colors.textMuted }]}>
            {deviceType === 'camera' ? 'Camera' : 'Voice'}
          </Text>
        </View>
      </View>
      <Text style={[styles.deviceTileMeta, { color: colors.textMuted }]} numberOfLines={2}>
        {roomLabel}
      </Text>
      <Text style={[styles.deviceTileMeta, { color: colors.textMuted }]} numberOfLines={1}>
        {device.address ?? ''}
      </Text>
    </TouchableOpacity>
  );
}

export function JarvisDeviceEditForm({
  device,
  rooms,
  userDirectory,
  onOpenStream,
  onSave,
  onDelete,
  colors,
}: {
  device: JarvisDevice;
  rooms: Room[];
  userDirectory: UserDirectoryEntry[];
  onOpenStream: (device: JarvisDevice) => void;
  onSave: (id: string, body: JarvisDeviceSaveBody) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  colors: {
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    error: string;
  };
}) {
  const [deviceName, setDeviceName] = useState(device.device_name);
  const [lanAddress, setLanAddress] = useState(device.address ?? '');
  const [callbackPortStr, setCallbackPortStr] = useState(
    device.callback_port != null ? String(device.callback_port) : ''
  );
  const [room, setRoom] = useState(device.room ?? '');
  const [deviceType, setDeviceType] = useState<JarvisDeviceType>(
    device.device_type || 'voice_interface'
  );
  const [actingUserId, setActingUserId] = useState(device.acting_user_id ?? '');
  const [doorbell, setDoorbell] = useState(device.doorbell_alerts_enabled);
  const [callbackSecret, setCallbackSecret] = useState('');
  const [describeScenePrompt, setDescribeScenePrompt] = useState(
    device.describe_scene_prompt ?? ''
  );
  const [mainDescribeCamera, setMainDescribeCamera] = useState(
    Boolean(device.is_main_describe_camera)
  );

  useEffect(() => {
    setDeviceName(device.device_name);
    setLanAddress(device.address ?? '');
    setCallbackPortStr(device.callback_port != null ? String(device.callback_port) : '');
    setRoom(device.room ?? '');
    setDeviceType(device.device_type || 'voice_interface');
    setActingUserId(device.acting_user_id ?? '');
    setDoorbell(device.doorbell_alerts_enabled);
    setCallbackSecret('');
    setDescribeScenePrompt(device.describe_scene_prompt ?? '');
    setMainDescribeCamera(Boolean(device.is_main_describe_camera));
  }, [
    device.device_name,
    device.address,
    device.callback_port,
    device.room,
    device.device_type,
    device.acting_user_id,
    device.doorbell_alerts_enabled,
    device.describe_scene_prompt,
    device.is_main_describe_camera,
    device.id,
  ]);

  const actingOptions = useMemo(
    () => [
      { label: 'Not set', value: '' },
      ...userDirectory.map((u) => ({
        label: u.display_name?.trim()
          ? `${u.display_name} (${u.email || u.user_id})`
          : u.email || u.user_id,
        value: u.user_id,
      })),
    ],
    [userDirectory]
  );

  // A device's room is its name, which is what the server matches room light
  // and room display requests against.
  const roomOptions = useMemo(
    () => [
      { label: 'No room', value: '' },
      ...rooms.map((entry) => ({ label: entry.name, value: entry.name })),
    ],
    [rooms]
  );

  const typeOptions = useMemo(
    () => [
      { label: 'Voice', value: 'voice_interface' as const },
      { label: 'Camera', value: 'camera' as const },
    ],
    []
  );

  return (
    <View>
      <View style={styles.jarvisTypeRow}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{device.device_name}</Text>
        <View
          style={[
            styles.typeBadge,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          <Text style={[styles.typeBadgeText, { color: colors.textMuted }]}>
            {deviceType === 'camera' ? 'Camera' : 'Voice'}
          </Text>
        </View>
      </View>
      <Field
        label="Device name"
        value={deviceName}
        onChangeText={setDeviceName}
        colors={colors}
      />
      <Field
        label="LAN address (mDNS hostname)"
        value={lanAddress}
        onChangeText={setLanAddress}
        placeholder="voice-node.local"
        colors={colors}
      />
      <Field
        label="Callback port (optional)"
        value={callbackPortStr}
        onChangeText={setCallbackPortStr}
        placeholder="8089 — leave empty for API default"
        colors={colors}
        keyboardType="number-pad"
      />
      <Text style={[styles.deviceNote, { color: colors.textMuted, marginBottom: 4 }]}>
        The API reaches this Pi on the LAN using the hostname and callback port (default 8089 when
        unset). Mobile apps use your public API URL only.
      </Text>
      {deviceType === 'camera' ? (
        <Field
          label="Callback secret (matches Pi; not shown after save)"
          value={callbackSecret}
          onChangeText={setCallbackSecret}
          placeholder="Leave blank to keep existing"
          colors={colors}
          secureTextEntry
        />
      ) : null}
      <PickerField
        label="Device type"
        value={deviceType}
        placeholder="Type"
        options={typeOptions}
        onSelect={(v) => {
          setDeviceType(v as JarvisDeviceType);
          if (v === 'camera') setDoorbell(false);
        }}
        colors={colors}
      />
      <PickerField
        label="Room"
        value={room}
        placeholder="Select room"
        options={roomOptions}
        onSelect={setRoom}
        colors={colors}
      />
      <PickerField
        label="Acts as user (API)"
        value={actingUserId}
        placeholder={
          userDirectory.length ? 'Select user' : 'Enter ID below or enable directory on API'
        }
        options={actingOptions}
        onSelect={setActingUserId}
        colors={colors}
      />
      {userDirectory.length === 0 ? (
        <Field
          label="Acting user id (manual)"
          value={actingUserId}
          onChangeText={setActingUserId}
          placeholder="Mongo / Google user id"
          colors={colors}
        />
      ) : null}
      {deviceType === 'voice_interface' ? (
        <TouchableOpacity
          style={styles.jarvisCheckRow}
          onPress={() => setDoorbell((d) => !d)}
        >
          <Ionicons
            name={doorbell ? 'checkbox' : 'square-outline'}
            size={22}
            color={doorbell ? colors.accent : colors.textMuted}
          />
          <Text style={[styles.jarvisCheckLabel, { color: colors.text }]}>
            Announce person detections from the doorbell camera
          </Text>
        </TouchableOpacity>
      ) : null}
      <Text style={[styles.deviceNote, { color: colors.textMuted }]}>
        Pi daemons should set the same acting user and device name in config. Camera devices stream
        video via the API (Cameras tab); voice devices with this enabled hear a spoken alert when the
        AI Camera first detects a person.
      </Text>
      {deviceType === 'camera' ? (
        <TouchableOpacity
          style={[styles.smallGhost, { borderColor: colors.border, marginBottom: 8 }]}
          onPress={() => onOpenStream({ ...device })}
        >
          <Text style={[styles.smallGhostText, { color: colors.text }]}>Snapshot preview (API)</Text>
        </TouchableOpacity>
      ) : null}
      {deviceType === 'camera' ? (
        <>
          <Field
            label="Custom describe-scene prompt (optional)"
            value={describeScenePrompt}
            onChangeText={setDescribeScenePrompt}
            placeholder="e.g. Note packages on the porch; our car is a blue Subaru…"
            colors={colors}
            multiline
            minHeight={100}
          />
          <Text style={[styles.deviceNote, { color: colors.textMuted, marginBottom: 8 }]}>
            Merged into Jarvis vision when describing this camera. Leave blank for generic scenes
            only.
          </Text>
          <TouchableOpacity
            style={styles.jarvisCheckRow}
            onPress={() => setMainDescribeCamera((m) => !m)}
          >
            <Ionicons
              name={mainDescribeCamera ? 'checkbox' : 'square-outline'}
              size={22}
              color={mainDescribeCamera ? colors.accent : colors.textMuted}
            />
            <Text style={[styles.jarvisCheckLabel, { color: colors.text }]}>
              Default camera for describe-scene (when the user does not name a camera)
            </Text>
          </TouchableOpacity>
        </>
      ) : null}
      <View style={styles.inlineActions}>
        <TouchableOpacity
          style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
          onPress={() => {
            const addr = lanAddress.trim();
            if (!addr) {
              Alert.alert('Address required', 'Enter this Pi’s LAN hostname (e.g. voice-node.local).');
              return;
            }
            const cp = callbackPortStr.trim();
            let callback_port: number | null | undefined;
            if (cp === '') {
              callback_port = null;
            } else {
              const n = parseInt(cp, 10);
              if (Number.isNaN(n) || n < 1 || n > 65535) {
                Alert.alert('Invalid port', 'Callback port must be a number from 1 to 65535.');
                return;
              }
              callback_port = n;
            }
            void onSave(device.id, {
              device_name: deviceName.trim(),
              address: addr,
              callback_port,
              room: room || null,
              device_type: deviceType,
              acting_user_id: actingUserId.trim() || null,
              doorbell_alerts_enabled: deviceType === 'voice_interface' ? doorbell : false,
              ...(deviceType === 'camera' && callbackSecret.trim()
                ? { callback_secret: callbackSecret.trim() }
                : {}),
              ...(deviceType === 'camera'
                ? {
                    describe_scene_prompt: describeScenePrompt.trim() || null,
                    is_main_describe_camera: mainDescribeCamera,
                  }
                : {}),
            });
          }}
        >
          <Text style={styles.smallPrimaryText}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.smallGhost, { borderColor: colors.border }]}
          onPress={() => void onDelete(device.id)}
        >
          <Text style={[styles.smallGhostText, { color: colors.text }]}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
