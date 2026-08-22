import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

export type SavedHostProfile = {
  hostId: string;
  hostName: string;
  address: string;
  capabilities: string[];
  pairedAt: number;
};

const PROFILE_KEY = "maxx.mobile.hostProfile.v1";
const CREDENTIAL_KEY = "maxx.mobile.hostCredential.v1";
const DEVICE_ID_KEY = "maxx.mobile.deviceID.v1";
const PINNED_KEY = "maxx.mobile.pinnedThreads.v1";
const UNSEEN_KEY = "maxx.mobile.unseenThreads.v1";
const PROVIDER_DIAGNOSTICS_KEY = "maxx.mobile.providerDiagnosticsVisible.v1";
const DEVICE_ONLY_ACCESS = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

export async function loadSavedConnection() {
  const [profileRaw, credential] = await Promise.all([
    SecureStore.getItemAsync(PROFILE_KEY),
    SecureStore.getItemAsync(CREDENTIAL_KEY),
  ]);
  if (!profileRaw || !credential) return null;
  try {
    return { profile: JSON.parse(profileRaw) as SavedHostProfile, credential };
  } catch {
    await clearSavedConnection();
    return null;
  }
}

export async function saveConnection(profile: SavedHostProfile, credential: string) {
  await Promise.all([
    SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(profile), {
      keychainAccessible: DEVICE_ONLY_ACCESS,
    }),
    SecureStore.setItemAsync(CREDENTIAL_KEY, credential, {
      keychainAccessible: DEVICE_ONLY_ACCESS,
    }),
  ]);
}

export async function clearSavedConnection() {
  await Promise.all([
    SecureStore.deleteItemAsync(PROFILE_KEY),
    SecureStore.deleteItemAsync(CREDENTIAL_KEY),
  ]);
}

export async function deviceID() {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = `mobile-${Crypto.randomUUID()}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id, {
    keychainAccessible: DEVICE_ONLY_ACCESS,
  });
  return id;
}

export async function loadPinnedThreadIDs() {
  const raw = await AsyncStorage.getItem(PINNED_KEY);
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function savePinnedThreadIDs(ids: string[]) {
  await AsyncStorage.setItem(PINNED_KEY, JSON.stringify([...new Set(ids)]));
}

export async function loadUnseenThreadIDs() {
  const raw = await AsyncStorage.getItem(UNSEEN_KEY);
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function saveUnseenThreadIDs(ids: string[]) {
  await AsyncStorage.setItem(UNSEEN_KEY, JSON.stringify([...new Set(ids)]));
}

export async function loadShowProviderDiagnostics() {
  return await AsyncStorage.getItem(PROVIDER_DIAGNOSTICS_KEY) === "true";
}

export async function saveShowProviderDiagnostics(visible: boolean) {
  await AsyncStorage.setItem(PROVIDER_DIAGNOSTICS_KEY, String(visible));
}
