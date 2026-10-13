/**
 * i18n/index.ts —— 轻量自研国际化入口（design.md §2.2，不引入 i18next 等重依赖）。
 *
 * 职责：
 *  - 三语字典（zh/en/ja）与 `translate(lang, key, params?)` 纯函数；
 *  - 语言状态存 uiStore（+ localStorage），`useTranslate()` 订阅语言——切换时
 *    所有使用该 hook 的组件即时重渲染；
 *  - `t(key, params?)` 非响应式版本（store/工具函数等渲染路径外使用，读当前语言）。
 * 失败行为：key 缺失 → 回退 zh → 仍缺失则原样返回 key（永不抛异常）；
 *   params 缺占位 → 保留 `{name}` 原文；多余 params 忽略。
 */
import { useUiStore, type Language } from '../store/uiStore';
import { zh } from './zh';
import { en } from './en';
import { ja } from './ja';

export type { Language };

/** 三语字典（顺序与 LANGUAGES 一致）。 */
export const DICTIONARIES: Record<Language, Record<string, string>> = {
  zh,
  en,
  ja,
};

/** 插值参数类型（数字/字符串）。 */
export type TranslateParams = Record<string, string | number>;

/** 纯翻译函数：lang 字典 → zh 回退 → key 原样返回。 */
export function translate(
  lang: Language,
  key: string,
  params?: TranslateParams,
): string {
  const raw = DICTIONARIES[lang]?.[key] ?? zh[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 非响应式翻译（渲染路径外：store/工具；语言取 uiStore 当前值）。 */
export function t(key: string, params?: TranslateParams): string {
  return translate(useUiStore.getState().language, key, params);
}

/**
 * 响应式翻译 hook：订阅 uiStore.language，切换语言时组件重渲染。
 * 返回绑定当前语言的 `(key, params?) => string`。
 */
export function useTranslate(): (key: string, params?: TranslateParams) => string {
  const lang = useUiStore((s) => s.language);
  return (key, params) => translate(lang, key, params);
}
