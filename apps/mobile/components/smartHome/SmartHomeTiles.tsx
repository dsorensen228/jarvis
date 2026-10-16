import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleProp,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';

import { Field, PickerField } from '@/components/settings/FormFields';
import { commandSmartDevice } from '@/lib/api-client';
import type { Room, SmartDevice, SmartDeviceUpdate } from '@/lib/api-client/types';

import {
  anyLightOn,
  componentLabel,
  deviceAnyPartOn,
  hasSeparateOutlets,
  powerableComponents,
} from './lightHelpers';
import { smartHomeStyles as styles } from './smartHomeStyles';

type TileColors = {
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
};

function roomOptions(rooms: Room[]) {
  return [{ label: 'No room', value: '' }, ...rooms.map((room) => ({ label: room.name, value: room.name }))];
}

export function SmartRoomCard({
  room,
  onSave,
  onDelete,
  lightsInRoom,
  lightsBusy,
  lightsToggleLocked,
  onToggleRoomLights,
  colors,
}: {
  room: Room;
  onSave: (name: string, newName: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  lightsInRoom: SmartDevice[];
  lightsBusy: boolean;
  lightsToggleLocked: boolean;
  onToggleRoomLights: () => void;
  colors: TileColors & { error: string };
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);

  const someLightOn = useMemo(() => anyLightOn(lightsInRoom), [lightsInRoom]);

  useEffect(() => {
    setName(room.name);
  }, [room.name]);

  return (
    <View
      style={[
        styles.inlineCard,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      {editing ? (
        <>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Room name"
            placeholderTextColor={colors.textMuted}
            style={[
              styles.input,
              {
                backgroundColor: '#090909',
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
          />
          <View style={styles.inlineActions}>
            <TouchableOpacity onPress={() => setEditing(false)}>
              <Text style={[styles.linkText, { color: colors.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
              onPress={() => {
                void onSave(room.name, name.trim());
                setEditing(false);
              }}
            >
              <Text style={styles.smallPrimaryText}>Save</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <View style={styles.smartRoomRow}>
          <View style={styles.smartRoomTitleBlock}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>{room.name}</Text>
            <Text style={[styles.cardMeta, { color: colors.textMuted }]}>
              {room.device_count} device{room.device_count === 1 ? '' : 's'}
            </Text>
          </View>
          <View style={styles.smartRoomTrailing}>
            <TouchableOpacity onPress={() => setEditing(true)}>
              <Ionicons name="pencil-outline" size={18} color={colors.accent} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void onDelete(room.name)}>
              <Ionicons name="trash-outline" size={18} color={colors.error} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.lightToggle,
                { backgroundColor: someLightOn ? `${colors.accent}22` : '#090909' },
              ]}
              onPress={() => void onToggleRoomLights()}
              disabled={lightsToggleLocked || lightsInRoom.length === 0}
            >
              {lightsBusy ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Ionicons
                  name={someLightOn ? 'bulb' : 'bulb-outline'}
                  size={20}
                  color={
                    lightsInRoom.length === 0
                      ? colors.textMuted
                      : someLightOn
                        ? colors.accent
                        : colors.textMuted
                  }
                />
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

/** A device with a screen. Power goes through the neutral media action. */
export function DisplayDeviceTile({
  device,
  rooms,
  onSave,
  onRefresh,
  onCommandError,
  colors,
  tileStyle,
}: {
  device: SmartDevice;
  rooms: Room[];
  onSave: (id: string, body: SmartDeviceUpdate) => Promise<void>;
  onRefresh: () => Promise<void>;
  onCommandError: (message: string) => void;
  colors: TileColors;
  tileStyle?: StyleProp<ViewStyle>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [room, setRoom] = useState(device.room);
  const [primary, setPrimary] = useState(Boolean(device.primary_for_room));
  const [powerBusy, setPowerBusy] = useState(false);

  useEffect(() => {
    setName(device.name);
    setRoom(device.room);
    setPrimary(Boolean(device.primary_for_room));
  }, [device.name, device.room, device.primary_for_room]);

  const sendPower = async () => {
    setPowerBusy(true);
    onCommandError('');
    try {
      await commandSmartDevice(device.id, {
        action: device.power === true ? 'turn_off' : 'turn_on',
      });
      await onRefresh();
    } catch (error) {
      onCommandError(
        error instanceof Error ? error.message : 'Could not change screen power.'
      );
      await onRefresh();
    } finally {
      setPowerBusy(false);
    }
  };

  return (
    <View
      style={[
        styles.deviceTile,
        tileStyle,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.deviceTileHeader}>
        <TouchableOpacity
          style={[
            styles.lightToggle,
            { backgroundColor: device.power === true ? `${colors.accent}22` : '#090909' },
          ]}
          onPress={() => void sendPower()}
          disabled={powerBusy}
        >
          <Ionicons
            name="tv-outline"
            size={20}
            color={device.available ? colors.accent : colors.textMuted}
          />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setEditing((value) => !value)}>
          <Ionicons
            name={editing ? 'checkmark-circle-outline' : 'pencil-outline'}
            size={18}
            color={editing ? colors.accent : colors.textMuted}
          />
        </TouchableOpacity>
      </View>
      {editing ? (
        <>
          <Field label="Name" value={name} onChangeText={setName} colors={colors} />
          <PickerField
            label="Room"
            value={room}
            placeholder="No room"
            options={roomOptions(rooms)}
            onSelect={setRoom}
            colors={colors}
          />
          <TouchableOpacity
            style={styles.checkboxRow}
            onPress={() => setPrimary((value) => !value)}
          >
            <Ionicons
              name={primary ? 'checkbox-outline' : 'square-outline'}
              size={18}
              color={primary ? colors.accent : colors.textMuted}
            />
            <Text style={[styles.checkboxLabel, { color: colors.textMuted }]}>
              Main screen for this room
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
            onPress={() => {
              void onSave(device.id, {
                name: name.trim() || undefined,
                room,
                primary_for_room: primary,
              });
              setEditing(false);
            }}
          >
            <Text style={styles.smallPrimaryText}>Save</Text>
          </TouchableOpacity>
        </>
      ) : (
        <View style={styles.deviceTileBody}>
          <Text style={[styles.deviceTileTitle, { color: colors.text }]} numberOfLines={2}>
            {device.name}
          </Text>
          <Text style={[styles.deviceTileMeta, { color: colors.textMuted }]} numberOfLines={2}>
            {device.available
              ? [device.room || 'No room', device.components[0]?.app].filter(Boolean).join(' · ')
              : 'Unavailable'}
          </Text>
        </View>
      )}
    </View>
  );
}

export function SmartDeviceTile({
  device,
  rooms,
  onTogglePower,
  onSave,
  onOpenDetail,
  colors,
  tileKind = 'light',
  tileStyle,
}: {
  device: SmartDevice;
  rooms: Room[];
  onTogglePower: (device: SmartDevice, componentKey?: string) => Promise<void>;
  onOpenDetail: (device: SmartDevice) => void;
  onSave: (id: string, body: SmartDeviceUpdate) => Promise<void>;
  colors: TileColors;
  tileKind?: 'light' | 'outlet';
  tileStyle?: StyleProp<ViewStyle>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [room, setRoom] = useState(device.room);
  const [isLight, setIsLight] = useState(device.is_light);

  useEffect(() => {
    setName(device.name);
    setRoom(device.room);
    setIsLight(device.is_light);
  }, [device.name, device.room, device.is_light]);

  const outlets = powerableComponents(device);
  const separateOutlets = hasSeparateOutlets(device);
  const on = separateOutlets ? deviceAnyPartOn(device) : device.power === true;
  const powerIconOn = tileKind === 'outlet' ? 'power' : 'bulb';
  const powerIconOff = tileKind === 'outlet' ? 'power-outline' : 'bulb-outline';

  return (
    <View
      style={[
        styles.deviceTile,
        separateOutlets ? styles.deviceTileCompound : null,
        tileStyle,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.deviceTileHeader}>
        <TouchableOpacity
          style={[
            styles.lightToggle,
            { backgroundColor: on ? `${colors.accent}22` : '#090909' },
          ]}
          onPress={() => void onTogglePower(device)}
        >
          <Ionicons
            name={on ? powerIconOn : powerIconOff}
            size={20}
            color={device.available ? (on ? colors.accent : colors.textMuted) : colors.textMuted}
          />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setEditing((value) => !value)}>
          <Ionicons
            name={editing ? 'checkmark-circle-outline' : 'pencil-outline'}
            size={18}
            color={editing ? colors.accent : colors.textMuted}
          />
        </TouchableOpacity>
      </View>
      {editing ? (
        <>
          <Field label="Name" value={name} onChangeText={setName} colors={colors} />
          <PickerField
            label="Room"
            value={room}
            placeholder="No room"
            options={roomOptions(rooms)}
            onSelect={setRoom}
            colors={colors}
          />
          <TouchableOpacity
            style={styles.checkboxRow}
            onPress={() => setIsLight((value) => !value)}
          >
            <Ionicons
              name={isLight ? 'checkbox-outline' : 'square-outline'}
              size={18}
              color={isLight ? colors.accent : colors.textMuted}
            />
            <Text style={[styles.checkboxLabel, { color: colors.textMuted }]}>
              Include in room and whole-house lights
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
            onPress={() => {
              void onSave(device.id, {
                name: name.trim() || undefined,
                room,
                is_light: isLight,
              });
              setEditing(false);
            }}
          >
            <Text style={styles.smallPrimaryText}>Save</Text>
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity style={styles.deviceTileBody} onPress={() => onOpenDetail(device)}>
          <Text style={[styles.deviceTileTitle, { color: colors.text }]} numberOfLines={2}>
            {device.name}
          </Text>
          <Text style={[styles.deviceTileMeta, { color: colors.textMuted }]} numberOfLines={2}>
            {device.available ? device.room || 'No room' : 'Unavailable'}
          </Text>
          {separateOutlets ? (
            <View style={styles.subDeviceRow}>
              {outlets.map((component) => (
                <TouchableOpacity
                  key={component.key}
                  style={[
                    styles.subDeviceChip,
                    {
                      borderColor: colors.border,
                      backgroundColor: component.power === true ? `${colors.accent}22` : '#090909',
                    },
                  ]}
                  onPress={() => void onTogglePower(device, component.key)}
                >
                  <Ionicons
                    name={component.power === true ? 'power' : 'power-outline'}
                    size={14}
                    color={component.power === true ? colors.accent : colors.textMuted}
                  />
                  <Text style={[styles.subDeviceChipText, { color: colors.text }]}>
                    {componentLabel(component)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </TouchableOpacity>
      )}
    </View>
  );
}
