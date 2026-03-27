import { Router, type Request, type Response } from "express";
import { getMetadata, getAllMetadata, setMetadata, deleteMetadata } from "../lib/social-store.js";
import { invalidateMergedCache } from "./sui-dex.js";
import { getAdsToken, setAdsToken } from "../lib/ads-store.js";

const router = Router();

const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] || "admin1234";

function checkAuth(req: Request, res: Response): boolean {
  const auth = (req.headers["x-admin-password"] as string) || (req.query.adminPassword as string);
  if (auth !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.get("/tokens", (_req, res) => {
  res.json(getAllMetadata());
});

router.get("/tokens/:tokenAddress", (req, res) => {
  const { tokenAddress } = req.params;
  res.json(getMetadata(tokenAddress));
});

router.post("/tokens/:tokenAddress", (req, res) => {
  if (!checkAuth(req, res)) return;
  const { tokenAddress } = req.params;
  const { socials, logoUrl, bannerUrl, tokenName, tokenSymbol } = req.body as {
    socials?: Array<{ platform: string; url: string; label?: string }>;
    logoUrl?: string;
    bannerUrl?: string;
    tokenName?: string;
    tokenSymbol?: string;
  };
  const update: Record<string, unknown> = {};
  if (socials !== undefined) update.socials = socials;
  if (logoUrl !== undefined) update.logoUrl = logoUrl;
  if (bannerUrl !== undefined) update.bannerUrl = bannerUrl;
  if (tokenName !== undefined) update.tokenName = tokenName;
  if (tokenSymbol !== undefined) update.tokenSymbol = tokenSymbol;
  setMetadata(tokenAddress, update);
  invalidateMergedCache();
  res.json({ ok: true, data: getMetadata(tokenAddress) });
});

router.delete("/tokens/:tokenAddress", (req, res) => {
  if (!checkAuth(req, res)) return;
  const { tokenAddress } = req.params;
  deleteMetadata(tokenAddress);
  invalidateMergedCache();
  res.json({ ok: true });
});

router.get("/socials", (_req, res) => {
  const all = getAllMetadata();
  const result: Record<string, unknown[]> = {};
  for (const [addr, meta] of Object.entries(all)) {
    result[addr] = meta.socials ?? [];
  }
  res.json(result);
});

router.get("/socials/:tokenAddress", (req, res) => {
  const { tokenAddress } = req.params;
  res.json(getMetadata(tokenAddress).socials ?? []);
});

router.post("/socials/:tokenAddress", (req, res) => {
  if (!checkAuth(req, res)) return;
  const { tokenAddress } = req.params;
  const links = req.body as unknown;
  if (!Array.isArray(links)) {
    res.status(400).json({ error: "Body must be an array of social links" });
    return;
  }
  setMetadata(tokenAddress, { socials: links });
  res.json({ ok: true, links: getMetadata(tokenAddress).socials ?? [] });
});

router.delete("/socials/:tokenAddress", (req, res) => {
  if (!checkAuth(req, res)) return;
  const { tokenAddress } = req.params;
  deleteMetadata(tokenAddress);
  res.json({ ok: true });
});

// ADS management
router.get("/ads", (_req, res) => {
  res.json({ tokenAddress: getAdsToken() });
});

router.post("/ads", (req, res) => {
  if (!checkAuth(req, res)) return;
  const { tokenAddress } = req.body as { tokenAddress?: string };
  if (!tokenAddress) {
    res.status(400).json({ error: "tokenAddress is required" });
    return;
  }
  setAdsToken(tokenAddress);
  res.json({ ok: true, tokenAddress: getAdsToken() });
});

router.delete("/ads", (req, res) => {
  if (!checkAuth(req, res)) return;
  setAdsToken(null);
  res.json({ ok: true });
});

export default router;
