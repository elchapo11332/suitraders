import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname2, "../../../../artifacts/data/social-links.json");

interface TokenMeta {
  socials?: Array<{ platform: string; url: string; label?: string }>;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  tokenName?: string;
  tokenSymbol?: string;
}

type Store = Record<string, TokenMeta>;

let _store: Store | null = null;

function load(): Store {
  if (_store) return _store;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as Record<string, unknown>;
      const migrated: Store = {};
      for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v)) {
          migrated[k] = { socials: v };
        } else {
          migrated[k] = v as TokenMeta;
        }
      }
      _store = migrated;
      return _store;
    }
  } catch {
    // ignore
  }
  _store = {};
  return _store;
}

function save(): void {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(_store, null, 2));
  } catch {
    // ignore
  }
}

function key(tokenAddress: string): string {
  return tokenAddress.toLowerCase().trim();
}

export function getMetadata(tokenAddress: string): TokenMeta {
  return load()[key(tokenAddress)] ?? {};
}

export function getAllMetadata(): Store {
  return load();
}

export function setMetadata(tokenAddress: string, meta: Partial<TokenMeta>): void {
  const existing = load()[key(tokenAddress)] ?? {};
  load()[key(tokenAddress)] = { ...existing, ...meta };
  save();
}

export function deleteMetadata(tokenAddress: string): void {
  delete load()[key(tokenAddress)];
  save();
}
