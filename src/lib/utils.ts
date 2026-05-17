import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(
  amount: number,
  currency: string = "USD",
  options: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    ...options,
  }).format(amount);
}

export function formatDateRange(start?: Date | null, end?: Date | null) {
  if (!start && !end) return "Flexible dates";
  if (start && !end) return formatDate(start);
  if (!start && end) return `by ${formatDate(end)}`;
  const sameMonth =
    start!.getMonth() === end!.getMonth() &&
    start!.getFullYear() === end!.getFullYear();
  if (sameMonth) {
    return `${start!.toLocaleString("en-US", { month: "short" })} ${start!.getDate()}–${end!.getDate()}, ${end!.getFullYear()}`;
  }
  return `${formatDate(start!)} → ${formatDate(end!)}`;
}

export function formatDate(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function initials(name?: string | null) {
  if (!name) return "·";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function slugify(input: string) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

export function pluralize(count: number, singular: string, plural?: string) {
  if (count === 1) return `${count} ${singular}`;
  return `${count} ${plural ?? singular + "s"}`;
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isServer() {
  return typeof window === "undefined";
}

export function safeJsonParse<T = unknown>(input: string | null | undefined): T | null {
  if (!input) return null;
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

export function relativeTime(date: Date | string | number) {
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 45) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 7) return `${day}d ago`;
  return formatDate(d);
}
