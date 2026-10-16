import {
  commandSmartDevice,
  createRoom,
  deleteRoom,
  renameRoom,
  updateSmartDevice,
} from '@/lib/api-client';
import { Section } from '@/components/settings/Section';
import {
  DisplayDeviceTile,
  SmartDeviceTile,
  SmartRoomCard,
} from '@/components/smartHome/SmartHomeTiles';
import {
  anyLightOn,
  componentFor,
  componentLabel,
  deviceHasCapability,
  hasSeparateOutlets,
  powerableComponents,
} from '@/components/smartHome/lightHelpers';
import { smartHomeStyles as styles } from '@/components/smartHome/smartHomeStyles';
import { useSmartHome } from '@/contexts/SmartHomeContext';
import { useTheme } from '@/contexts/ThemeContext';
import type { SmartDevice } from '@/lib/api-client/types';
import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const DEFAULT_MIN_KELVIN = 2200;
const DEFAULT_MAX_KELVIN = 6500;

export function HomeTab() {
  const { colors } = useTheme();
  const {
    loadSmartControls,
    smartDevices,
    rooms,
    status,
    syncingDevices,
    syncError,
    deviceCommandError,
    reportDeviceCommandError,
    bulkLightsBusyKey,
    setTileGridInnerWidth,
    tileWidth,
    lightsByRoom,
    smartDevicesByRoom,
    handleSync,
    toggleDevicePower,
    toggleLightsBucket,
  } = useSmartHome();

  const [newRoomName, setNewRoomName] = useState('');
  const [detailDevice, setDetailDevice] = useState<SmartDevice | null>(null);
  const [detailBrightness, setDetailBrightness] = useState(50);
  const [detailKelvin, setDetailKelvin] = useState(3500);
  const [detailLabels, setDetailLabels] = useState<Record<string, string>>({});

  // The detail modal only offers what the device itself reports it can do.
  const brightnessComponent = componentFor(detailDevice, 'brightness');
  const kelvinComponent = componentFor(detailDevice, 'color_temperature');
  const minKelvin = kelvinComponent?.min_kelvin ?? DEFAULT_MIN_KELVIN;
  const maxKelvin = kelvinComponent?.max_kelvin ?? DEFAULT_MAX_KELVIN;

  const openDetail = (device: SmartDevice) => {
    const brightness = componentFor(device, 'brightness');
    const kelvin = componentFor(device, 'color_temperature');
    setDetailDevice(device);
    setDetailBrightness(brightness?.brightness_percent ?? 50);
    setDetailKelvin(
      kelvin?.kelvin ?? Math.round(((kelvin?.min_kelvin ?? DEFAULT_MIN_KELVIN) + (kelvin?.max_kelvin ?? DEFAULT_MAX_KELVIN)) / 2)
    );
    setDetailLabels(
      Object.fromEntries(powerableComponents(device).map((c) => [c.key, componentLabel(c)]))
    );
  };

  const runAndRefresh = (work: Promise<unknown>) => {
    void work.then(loadSmartControls).catch(loadSmartControls);
  };

  const platformNote = () => {
    if (deviceCommandError) return deviceCommandError;
    if (syncError) return syncError;
    if (!status) return 'Checking Home Assistant…';
    if (!status.configured) return 'Home Assistant is not configured on the server.';
    if (!status.connected) return status.error || 'Home Assistant is unreachable.';
    const orphaned = status.orphaned_count
      ? ` · ${status.orphaned_count} unavailable`
      : '';
    return `Home Assistant ${status.version} · ${status.device_count} devices${orphaned}`;
  };

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.screenContent}
      showsVerticalScrollIndicator={false}
    >
      <Section
        title="Home"
        subtitle="Rooms, lights, and screens. Home Assistant discovers the devices; Sync imports them."
        colors={colors}
      >
        <View style={styles.sectionHeaderRow}>
          <Text
            style={[
              styles.deviceNote,
              { color: syncError || deviceCommandError ? colors.error : colors.textMuted, flex: 1 },
            ]}
            numberOfLines={2}
          >
            {platformNote()}
          </Text>
          <TouchableOpacity
            style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
            onPress={() => void handleSync()}
            disabled={syncingDevices}
          >
            {syncingDevices ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.smallPrimaryText}>Sync</Text>
            )}
          </TouchableOpacity>
        </View>

        <Text style={[styles.subsectionTitle, { color: colors.text, marginTop: 16 }]}>Rooms</Text>
        <View style={styles.addRow}>
          <TextInput
            value={newRoomName}
            onChangeText={setNewRoomName}
            placeholder="Add room"
            placeholderTextColor={colors.textMuted}
            style={[
              styles.input,
              styles.inputGrow,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
          />
          <TouchableOpacity
            style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
            onPress={async () => {
              if (!newRoomName.trim()) return;
              await createRoom(newRoomName.trim());
              setNewRoomName('');
              await loadSmartControls();
            }}
          >
            <Text style={styles.smallPrimaryText}>Add</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.inlineStack}>
          {rooms.map((room) => {
            const lightsInRoom = lightsByRoom.get(room.name) ?? [];
            const roomBusyKey = `room:${room.name}`;
            return (
              <SmartRoomCard
                key={room.name}
                room={room}
                colors={colors}
                lightsInRoom={lightsInRoom}
                lightsBusy={bulkLightsBusyKey === roomBusyKey}
                lightsToggleLocked={bulkLightsBusyKey !== null}
                onToggleRoomLights={() => void toggleLightsBucket(lightsInRoom, roomBusyKey)}
                onSave={async (name, newName) => {
                  if (!newName || newName === name) return;
                  await renameRoom(name, newName);
                  await loadSmartControls();
                }}
                onDelete={async (name) => {
                  await deleteRoom(name);
                  await loadSmartControls();
                }}
              />
            );
          })}
        </View>

        <Text style={[styles.subsectionTitle, { color: colors.text, marginTop: 16 }]}>
          Lights, outlets & screens
        </Text>
        {smartDevices.length === 0 ? (
          <Text style={[styles.deviceNote, { color: colors.textMuted }]}>
            No devices yet. Add them in Home Assistant, then Sync.
          </Text>
        ) : (
          <View style={styles.inlineStack}>
            {smartDevicesByRoom.map((bucket) => {
              const bucketBusyKey = `bucket:${bucket.roomKey}`;
              const bucketAnyOn = anyLightOn(bucket.lights);
              const bucketBusy = bulkLightsBusyKey === bucketBusyKey;
              return (
                <View key={bucket.roomKey} style={styles.roomDeviceGroup}>
                  <View style={styles.roomDeviceHeadingRow}>
                    <Text
                      style={[styles.roomDeviceHeading, { color: colors.textMuted, flex: 1, minWidth: 0 }]}
                      numberOfLines={2}
                    >
                      {bucket.roomKey}
                    </Text>
                    <TouchableOpacity
                      style={[
                        styles.lightToggle,
                        { backgroundColor: bucketAnyOn ? `${colors.accent}22` : '#090909' },
                      ]}
                      onPress={() => void toggleLightsBucket(bucket.lights, bucketBusyKey)}
                      disabled={bucket.lights.length === 0 || bulkLightsBusyKey !== null}
                    >
                      {bucketBusy ? (
                        <ActivityIndicator size="small" color={colors.accent} />
                      ) : (
                        <Ionicons
                          name={bucketAnyOn ? 'bulb' : 'bulb-outline'}
                          size={20}
                          color={
                            bucket.lights.length === 0
                              ? colors.textMuted
                              : bucketAnyOn
                                ? colors.accent
                                : colors.textMuted
                          }
                        />
                      )}
                    </TouchableOpacity>
                  </View>
                  <View
                    style={styles.deviceGrid}
                    onLayout={(e) => setTileGridInnerWidth(e.nativeEvent.layout.width)}
                  >
                    {bucket.lights.map((device) => (
                      <SmartDeviceTile
                        key={`l-${device.id}`}
                        device={device}
                        rooms={rooms}
                        colors={colors}
                        tileKind="light"
                        tileStyle={{
                          width: hasSeparateOutlets(device) ? tileWidth * 2 + 12 : tileWidth,
                        }}
                        onTogglePower={toggleDevicePower}
                        onOpenDetail={openDetail}
                        onSave={async (id, body) => {
                          await updateSmartDevice(id, body);
                          await loadSmartControls();
                        }}
                      />
                    ))}
                    {bucket.others.map((device) => (
                      <SmartDeviceTile
                        key={`o-${device.id}`}
                        device={device}
                        rooms={rooms}
                        colors={colors}
                        tileKind="outlet"
                        tileStyle={{
                          width: hasSeparateOutlets(device) ? tileWidth * 2 + 12 : tileWidth,
                        }}
                        onTogglePower={toggleDevicePower}
                        onOpenDetail={openDetail}
                        onSave={async (id, body) => {
                          await updateSmartDevice(id, body);
                          await loadSmartControls();
                        }}
                      />
                    ))}
                    {bucket.displays.map((device) => (
                      <DisplayDeviceTile
                        key={`d-${device.id}`}
                        device={device}
                        rooms={rooms}
                        colors={colors}
                        tileStyle={{ width: tileWidth }}
                        onRefresh={loadSmartControls}
                        onCommandError={reportDeviceCommandError}
                        onSave={async (id, body) => {
                          await updateSmartDevice(id, body);
                          await loadSmartControls();
                        }}
                      />
                    ))}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        <Modal
          visible={detailDevice != null}
          transparent
          animationType="fade"
          onRequestClose={() => setDetailDevice(null)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setDetailDevice(null)}>
            <Pressable
              style={[styles.pickerModal, { backgroundColor: colors.surface }]}
              onPress={(event) => event.stopPropagation()}
            >
              <View style={styles.modalCardBody}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>
                  {detailDevice?.name ?? 'Device'}
                </Text>
                <Text style={[styles.sectionSubtitle, { color: colors.textMuted }]}>
                  {detailDevice?.available
                    ? 'Controls reflect what this device reports it can do.'
                    : 'This device is not reachable right now.'}
                </Text>
                {detailDevice && hasSeparateOutlets(detailDevice) ? (
                  <>
                    <View style={styles.subDeviceRow}>
                      {powerableComponents(detailDevice).map((component) => (
                        <TouchableOpacity
                          key={component.key}
                          style={[
                            styles.subDeviceChip,
                            {
                              borderColor: colors.border,
                              backgroundColor:
                                component.power === true ? `${colors.accent}22` : '#090909',
                            },
                          ]}
                          onPress={() => void toggleDevicePower(detailDevice, component.key)}
                        >
                          <Ionicons
                            name={component.power === true ? 'power' : 'power-outline'}
                            size={14}
                            color={component.power === true ? colors.accent : colors.textMuted}
                          />
                          <Text style={[styles.subDeviceChipText, { color: colors.text }]}>
                            {detailLabels[component.key] || componentLabel(component)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    {powerableComponents(detailDevice).map((component) => (
                      <View key={`label-${component.key}`} style={styles.field}>
                        <Text style={[styles.fieldLabel, { color: colors.text }]}>
                          Label: {component.default_name || component.key}
                        </Text>
                        <TextInput
                          value={detailLabels[component.key] || ''}
                          onChangeText={(value) =>
                            setDetailLabels((prev) => ({ ...prev, [component.key]: value }))
                          }
                          placeholderTextColor={colors.textMuted}
                          style={[
                            styles.input,
                            {
                              backgroundColor: colors.surface,
                              borderColor: colors.border,
                              color: colors.text,
                            },
                          ]}
                        />
                      </View>
                    ))}
                    <TouchableOpacity
                      style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
                      onPress={() =>
                        runAndRefresh(
                          updateSmartDevice(detailDevice.id, { component_labels: detailLabels })
                        )
                      }
                    >
                      <Text style={styles.smallPrimaryText}>Save outlet labels</Text>
                    </TouchableOpacity>
                  </>
                ) : null}
                <View style={styles.inlineActions}>
                  <TouchableOpacity
                    style={[styles.smallGhost, { borderColor: colors.border }]}
                    onPress={() =>
                      runAndRefresh(commandSmartDevice(detailDevice!.id, { action: 'turn_on' }))
                    }
                  >
                    <Text style={[styles.smallGhostText, { color: colors.text }]}>On</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.smallGhost, { borderColor: colors.border }]}
                    onPress={() =>
                      runAndRefresh(commandSmartDevice(detailDevice!.id, { action: 'turn_off' }))
                    }
                  >
                    <Text style={[styles.smallGhostText, { color: colors.text }]}>Off</Text>
                  </TouchableOpacity>
                </View>
                {deviceHasCapability(detailDevice, 'brightness') ? (
                  <>
                    <Text style={[styles.fieldLabel, { color: colors.text }]}>
                      Brightness ({detailBrightness}%)
                    </Text>
                    <Slider
                      style={styles.costSlider}
                      minimumValue={1}
                      maximumValue={100}
                      step={1}
                      value={detailBrightness}
                      minimumTrackTintColor={colors.accent}
                      maximumTrackTintColor={colors.border}
                      thumbTintColor={colors.accent}
                      onValueChange={(value) => setDetailBrightness(Math.round(value))}
                      onSlidingComplete={(value) =>
                        runAndRefresh(
                          commandSmartDevice(detailDevice!.id, {
                            action: 'brightness',
                            component: brightnessComponent?.key,
                            parameters: { percent: Math.round(value) },
                          })
                        )
                      }
                    />
                  </>
                ) : null}
                {deviceHasCapability(detailDevice, 'color_temperature') ? (
                  <>
                    <Text style={[styles.fieldLabel, { color: colors.text }]}>
                      Color temperature ({detailKelvin}K)
                    </Text>
                    <Slider
                      style={styles.costSlider}
                      minimumValue={minKelvin}
                      maximumValue={maxKelvin}
                      step={50}
                      value={Math.min(maxKelvin, Math.max(minKelvin, detailKelvin))}
                      minimumTrackTintColor={colors.accent}
                      maximumTrackTintColor={colors.border}
                      thumbTintColor={colors.accent}
                      onValueChange={(value) => setDetailKelvin(Math.round(value))}
                      onSlidingComplete={(value) =>
                        runAndRefresh(
                          commandSmartDevice(detailDevice!.id, {
                            action: 'color_temperature',
                            component: kelvinComponent?.key,
                            parameters: { kelvin: Math.round(value) },
                          })
                        )
                      }
                    />
                  </>
                ) : null}
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </Section>
    </ScrollView>
  );
}
