import type { MemeInfoResponse } from "../../types";

export interface ElementLike {
  type?: string;
  attrs?: {
    id?: unknown;
    name?: unknown;
    userId?: unknown;
    qq?: unknown;
  };
  children?: ElementLike[];
}

export interface MemeListInfoResult {
  key: string;
  info?: MemeInfoResponse;
}

export type MemeListCategory =
  | "no-args"
  | "text-only"
  | "image-only"
  | "image-and-text"
  | "unknown";

export interface MemeListEntry {
  alias: string;
  category: MemeListCategory;
}

export interface MemeListSection {
  title: string;
  aliases: string[];
}

export const MEME_LIST_CATEGORY_ORDER: MemeListCategory[] = [
  "no-args",
  "text-only",
  "image-only",
  "image-and-text",
  "unknown",
];

export const MEME_LIST_CATEGORY_LABEL: Record<MemeListCategory, string> = {
  "no-args": "无需参数",
  "text-only": "仅需文字",
  "image-only": "仅需图片",
  "image-and-text": "图片+文字",
  unknown: "信息获取失败",
};
