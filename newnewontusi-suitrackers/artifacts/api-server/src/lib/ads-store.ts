import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const ADS_FILE = path.join(__dirname2, "../../../../artifacts/data/ads.json");

interface AdsData {
  tokenAddress: string | null;
  setAt: string | null;
}

let _data: AdsData = { tokenAddress: null, setAt: null };
let _loaded = false;

function load(): AdsData {
  if (_loaded) return _data;
  try {
    if (fs.existsSync(ADS_FILE)) {
      _data = JSON.parse(fs.readFileSync(ADS_FILE, "utf-8")) as AdsData;
    }
  } catch {
    // ignore
  }
  _loaded = true;
  return _data;
}

function save(): void {
  try {
    const dir = path.dirname(ADS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ADS_FILE, JSON.stringify(_data, null, 2));
  } catch {
    // ignore
  }
}

export function getAdsToken(): string | null {
  return load().tokenAddress;
}

export function setAdsToken(address: string | null): void {
  _data = { tokenAddress: address ? address.toLowerCase().trim() : null, setAt: address ? new Date().toISOString() : null };
  _loaded = true;
  save();
}
