import type { SmartDevice, SmartDeviceComponent, SmartHomeCapability } from '@/lib/api-client/types';

/** The components of a device that can actually be powered. */
export function powerableComponents(device: SmartDevice): SmartDeviceComponent[] {
  return device.components.filter((component) => component.capabilities.includes('power'));
}

export function deviceHasCapability(
  device: SmartDevice | null | undefined,
  capability: SmartHomeCapability
): boolean {
  return Boolean(device?.capabilities.includes(capability));
}

export function componentFor(
  device: SmartDevice | null | undefined,
  capability: SmartHomeCapability
): SmartDeviceComponent | undefined {
  return device?.components.find((component) => component.capabilities.includes(capability));
}

/** A device with more than one powerable component, such as a dual outlet plug. */
export function hasSeparateOutlets(device: SmartDevice): boolean {
  return powerableComponents(device).length > 1;
}

export function hasScreen(device: SmartDevice): boolean {
  return device.components.some((component) => component.domain === 'media_player');
}

/** Plugs and other switchable gear that are not in bulk-light or TV buckets. */
export function isOutletOrOtherDevice(device: SmartDevice): boolean {
  if (device.is_light || hasScreen(device)) return false;
  return powerableComponents(device).length > 0;
}

function aggregateDevicePower(
  components: SmartDeviceComponent[],
  previous: boolean | null
): boolean | null {
  const parts = components.filter((component) => component.capabilities.includes('power'));
  if (parts.length === 0) return previous;
  if (parts.some((component) => component.power === true)) return true;
  if (parts.every((component) => component.power === false)) return false;
  return null;
}

/** True if any part of the device is on. A partly-on plug counts as on. */
export function deviceAnyPartOn(device: SmartDevice): boolean {
  if (device.power === true) return true;
  return powerableComponents(device).some((component) => component.power === true);
}

/** True if any part's power is unknown, so the next tap has nothing to invert. */
export function deviceAnyPartPowerUnknown(device: SmartDevice): boolean {
  const parts = powerableComponents(device);
  if (parts.length === 0) return device.power !== true && device.power !== false;
  return parts.some((component) => component.power !== true && component.power !== false);
}

export function anyLightOn(devices: SmartDevice[]): boolean {
  return devices.some(deviceAnyPartOn);
}

export function anyLightPowerUnknown(devices: SmartDevice[]): boolean {
  return devices.some(deviceAnyPartPowerUnknown);
}

export type PowerOp = { id: string; component?: string };

/** Only touch the parts that are not already known to be at the target state. */
export function collectPowerOps(devices: SmartDevice[], targetOn: boolean): PowerOp[] {
  const needsChange = (power: boolean | null) => (targetOn ? power !== true : power !== false);
  const ops: PowerOp[] = [];
  for (const device of devices) {
    const parts = powerableComponents(device);
    if (parts.length > 1) {
      for (const component of parts) {
        if (needsChange(component.power)) ops.push({ id: device.id, component: component.key });
      }
    } else if (parts.length === 1) {
      if (needsChange(parts[0].power)) ops.push({ id: device.id });
    }
  }
  return ops;
}

/** Optimistic local update so a tap feels immediate. */
export function applyPowerOp(
  devices: SmartDevice[],
  deviceId: string,
  on: boolean,
  componentKey?: string
): SmartDevice[] {
  return devices.map((device) => {
    if (device.id !== deviceId) return device;
    const components = device.components.map((component) =>
      !componentKey || component.key === componentKey ? { ...component, power: on } : component
    );
    const power = componentKey ? aggregateDevicePower(components, device.power) : on;
    return { ...device, components, power };
  });
}

export function componentLabel(component: SmartDeviceComponent): string {
  if (component.name || component.default_name) return component.name || component.default_name;
  // The main component of a plug with separate outlets is its master switch.
  return component.key === 'main' ? 'All' : component.key;
}
