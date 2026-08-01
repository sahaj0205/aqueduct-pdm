/**
 * Every number the platform prints goes through here. No screen formats one inline —
 * that is how a date ends up as "Wed Oct 14" on one screen and "2026-10-14" on another.
 */

import type { EvidenceQuality, FaultClass, HealthBand, Tier } from "../types.ts";

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.abs(n) >= 1000 ? usdWhole.format(n) : usdCents.format(n);
}

export function usdPerDay(n: number): string {
  return `${usd(n)}/day`;
}

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function ratio(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(n < 10 ? 1 : 0)}×`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateShortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function date(iso: string | null): string {
  if (!iso) return "—";
  return dateFmt.format(new Date(iso));
}

export function dateShort(iso: string | null): string {
  if (!iso) return "—";
  return dateShortFmt.format(new Date(iso));
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function relativeToNow(iso: string | null): string {
  if (!iso) return "—";
  const d = daysUntil(iso);
  if (d === null) return "—";
  if (d < 0) return `${Math.abs(d)} d overdue`;
  if (d === 0) return "today";
  return `in ${d} d`;
}

export function relativeSince(iso: string | null): string {
  const d = daysSince(iso);
  if (d === null) return "—";
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} d ago`;
}

export function healthBandOf(health: number | null): HealthBand | null {
  if (health === null) return null;
  if (health >= 85) return "healthy";
  if (health >= 70) return "watch";
  if (health >= 50) return "degraded";
  return "critical";
}

export function tierOfBand(band: HealthBand | null): Tier {
  switch (band) {
    case "healthy":
      return "low";
    case "watch":
      return "medium";
    case "degraded":
      return "high";
    case "critical":
    default:
      return "critical";
  }
}

export const BAND_LABEL: Record<HealthBand, string> = {
  healthy: "Healthy",
  watch: "Watch",
  degraded: "Degraded",
  critical: "Critical",
};

export const FAULT_CLASS_LABEL: Record<FaultClass, string> = {
  sensor: "Sensor",
  equipment: "Equipment",
  control: "Control",
  ambiguous: "Ambiguous",
};

export const EVIDENCE_LABEL: Record<EvidenceQuality, string> = {
  clean: "Clean evidence",
  partial: "Partial evidence",
  degraded: "Degraded evidence",
};

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${num(n)} ${n === 1 ? word : pluralWord}`;
}

export function kwh(n: number): string {
  return `${num(n, 1)} kWh`;
}
