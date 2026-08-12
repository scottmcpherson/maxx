import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { safeStorage, type Session, type WebContents } from "electron";

const executeFile = promisify(execFile);
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

interface ChromeProfile {
  id: string;
  name: string;
}

interface ImportStatus {
  available: boolean;
  profiles: ChromeProfile[];
  importedAt: number | null;
  lastProfile: string | null;
  cookieCount: number;
  passwordCount: number;
}

interface StoredCredential {
  origin: string;
  username: string;
  password: string;
}

interface EncryptedCredential {
  origin: string;
  usernameCiphertext: string;
  passwordCiphertext: string;
}

interface ImportMetadata {
  importedAt: number;
  lastProfile: string;
  cookieCount: number;
  passwordCount: number;
}

interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: string;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

interface ChromeLoginRow {
  origin_url: string;
  username_value: string;
  password_value: string;
}

export class ChromeImporter {
  readonly #session: Session;
  readonly #chromeRoot = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  readonly #vaultPath: string;
  readonly #metadataPath: string;

  constructor(browserSession: Session, userDataPath: string) {
    this.#session = browserSession;
    this.#vaultPath = path.join(userDataPath, "browser-password-vault.json");
    this.#metadataPath = path.join(userDataPath, "browser-import.json");
  }

  async status(): Promise<ImportStatus> {
    const profiles = await this.#profiles();
    const metadata = await this.#readJSON<ImportMetadata>(this.#metadataPath);
    return {
      available: profiles.length > 0,
      profiles,
      importedAt: metadata?.importedAt ?? null,
      lastProfile: metadata?.lastProfile ?? null,
      cookieCount: metadata?.cookieCount ?? 0,
      passwordCount: metadata?.passwordCount ?? 0,
    };
  }

  async import(profileId: string): Promise<ImportStatus> {
    const profiles = await this.#profiles();
    if (!profiles.some((profile) => profile.id === profileId)) throw new Error("Chrome profile does not exist");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable");
    const secret = await this.#chromeSecret();
    const profileRoot = path.join(this.#chromeRoot, profileId);
    const cookies = await this.#readDatabase<ChromeCookieRow>(
      path.join(profileRoot, "Network", "Cookies"),
      "SELECT json_object('host_key',host_key,'name',name,'value',value,'encrypted_value',hex(encrypted_value),'path',path,'expires_utc',expires_utc,'is_secure',is_secure,'is_httponly',is_httponly,'samesite',samesite) FROM cookies LIMIT 100000",
    );
    let cookieCount = 0;
    for (const row of cookies) {
      const cookieValue = row.value || this.#decryptChromeValue(row.encrypted_value, secret, row.host_key);
      if (!cookieValue) continue;
      const host = row.host_key.replace(/^\./, "");
      if (!host) continue;
      const expirationDate = Number(row.expires_utc) / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
      try {
        await this.#session.cookies.set({
          url: `${row.is_secure ? "https" : "http"}://${host}${row.path || "/"}`,
          name: row.name,
          value: cookieValue,
          domain: row.host_key,
          path: row.path || "/",
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          sameSite: row.samesite === 2 ? "strict" : row.samesite === 1 ? "lax" : row.samesite === 0 ? "no_restriction" : "unspecified",
          expirationDate: Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000 ? expirationDate : undefined,
        });
        cookieCount += 1;
      } catch {
        // Chromium rejects stale or malformed rows; one bad cookie must not
        // prevent the rest of the profile from importing.
      }
    }

    const logins = await this.#readDatabase<ChromeLoginRow>(
      path.join(profileRoot, "Login Data"),
      "SELECT json_object('origin_url',origin_url,'username_value',username_value,'password_value',hex(password_value)) FROM logins WHERE blacklisted_by_user=0 ORDER BY date_last_used DESC LIMIT 10000",
    );
    const credentials = logins.flatMap((row): StoredCredential[] => {
      const password = this.#decryptChromeValue(row.password_value, secret);
      if (!password || !row.username_value) return [];
      try { return [{ origin: new URL(row.origin_url).origin, username: row.username_value, password }]; }
      catch { return []; }
    });
    await this.#writeVault(credentials);
    const metadata: ImportMetadata = { importedAt: Date.now(), lastProfile: profileId, cookieCount, passwordCount: credentials.length };
    await this.#writePrivateJSON(this.#metadataPath, metadata);
    await this.#session.flushStorageData();
    return this.status();
  }

  async fillSavedPassword(contents: WebContents): Promise<boolean> {
    const url = contents.getURL();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
    const origin = new URL(url).origin;
    const vault = await this.#readJSON<EncryptedCredential[]>(this.#vaultPath) ?? [];
    const match = vault.find((credential) => credential.origin === origin);
    if (!match) return false;
    let username: string;
    let password: string;
    try {
      username = safeStorage.decryptString(Buffer.from(match.usernameCiphertext, "base64"));
      password = safeStorage.decryptString(Buffer.from(match.passwordCiphertext, "base64"));
    } catch {
      return false;
    }
    const script = `(() => {
      const username = ${JSON.stringify(username)};
      const password = ${JSON.stringify(password)};
      const passwordInput = [...document.querySelectorAll('input[type="password"]')].find((input) => !input.disabled && input.offsetParent);
      if (!passwordInput) return false;
      const form = passwordInput.form || passwordInput.closest('form') || document;
      const usernameInput = [...form.querySelectorAll('input')].find((input) => !input.disabled && input.offsetParent && ['email','text','tel'].includes(input.type));
      const set = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (usernameInput) set(usernameInput, username);
      set(passwordInput, password);
      passwordInput.focus();
      return true;
    })()`;
    try { return Boolean(await contents.executeJavaScript(script, true)); }
    finally { username = ""; password = ""; }
  }

  async #profiles(): Promise<ChromeProfile[]> {
    let entries: string[];
    try { entries = await readdir(this.#chromeRoot); } catch { return []; }
    const profileIds = entries.filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry));
    const localState = await this.#readJSON<{ profile?: { info_cache?: Record<string, { name?: string }> } }>(path.join(this.#chromeRoot, "Local State"));
    return profileIds.map((id) => ({ id, name: localState?.profile?.info_cache?.[id]?.name || id }));
  }

  async #chromeSecret(): Promise<string> {
    const { stdout } = await executeFile("/usr/bin/security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"], { maxBuffer: 1024 * 1024 });
    const secret = stdout.trim();
    if (!secret) throw new Error("Chrome Safe Storage key was empty");
    return secret;
  }

  #decryptChromeValue(hex: string, secret: string, cookieHost?: string): string {
    if (!hex) return "";
    const encrypted = Buffer.from(hex, "hex");
    if (encrypted.length < 4) return "";
    const prefix = encrypted.subarray(0, 3).toString("utf8");
    if (prefix !== "v10" && prefix !== "v11") return "";
    try {
      const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
      const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      let cleartext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
      // Current Chrome cookie stores bind encrypted values to their host by
      // prefixing SHA-256(host_key). Older stores and Login Data do not.
      if (cookieHost && cleartext.length >= 32) {
        const hostDigest = createHash("sha256").update(cookieHost).digest();
        if (timingSafeEqual(cleartext.subarray(0, 32), hostDigest)) cleartext = cleartext.subarray(32);
      }
      return cleartext.toString("utf8");
    } catch {
      return "";
    }
  }

  async #readDatabase<T>(database: string, query: string): Promise<T[]> {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "maxx-chrome-import-"));
    const copy = path.join(temporary, "database.sqlite");
    try {
      const escapedCopy = copy.replaceAll("'", "''");
      // SQLite's online backup includes committed WAL pages while Chrome is
      // running and avoids touching or locking the user's live profile files.
      await executeFile("/usr/bin/sqlite3", ["-batch", database, `.backup '${escapedCopy}'`], { maxBuffer: 1024 * 1024 });
      const { stdout } = await executeFile("/usr/bin/sqlite3", ["-batch", "-noheader", copy, query], { maxBuffer: 100 * 1024 * 1024 });
      return stdout.split(/\r?\n/).filter(Boolean).flatMap((line): T[] => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #writeVault(credentials: StoredCredential[]): Promise<void> {
    const encrypted: EncryptedCredential[] = credentials.map((credential) => ({
      origin: credential.origin,
      usernameCiphertext: safeStorage.encryptString(credential.username).toString("base64"),
      passwordCiphertext: safeStorage.encryptString(credential.password).toString("base64"),
    }));
    await this.#writePrivateJSON(this.#vaultPath, encrypted);
  }

  async #writePrivateJSON(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600);
  }

  async #readJSON<T>(filePath: string): Promise<T | null> {
    try { return JSON.parse(await readFile(filePath, "utf8")) as T; }
    catch { return null; }
  }
}
