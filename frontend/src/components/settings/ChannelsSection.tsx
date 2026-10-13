/**
 * ChannelsSection.tsx —— 设置页分区三「提供商渠道」（design.md §5 v1.1，admin API）。
 *
 * 职责：
 *  - 渠道列表（GET admin/models）：ref/provider/model/base_url/密钥已设置√/
 *    default_thinking + 编辑/删除操作；
 *  - 新建/编辑表单：api_key_inline 仅写入框（type=password，留空=不修改），
 *    **保存后永不回显**（契约 §5：响应只有 has_api_key）；保存 PUT →
 *    刷新列表 + appStore.refreshModelChannels（顶栏选择同步）；
 *  - 删除：两段式内联确认（第一次点击武装、第二次执行）；基底渠道由
 *    后端 409 拒绝（错误内联展示）；
 *  - 错误态：加载失败/保存失败内联展示；空态文案。
 * Props 契约：无 props（直接经 getApi() 调用 admin 端点）。
 */
import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../../api';
import { useAppStore } from '../../store/appStore';
import { useTranslate, t as translate } from '../../i18n';
import {
  THINKING_LEVELS,
  parseThinkingLevel,
  type ModelChannel,
  type ModelChannelInput,
} from '../../types/domain';

const PROVIDERS = ['openai', 'anthropic', 'mock'] as const;

/** 表单草稿（api_key_inline 独立字段，编辑态永不为渠道已有密钥回填）。 */
interface ChannelDraft {
  ref: string;
  provider: (typeof PROVIDERS)[number];
  model: string;
  base_url: string;
  api_key_env: string;
  api_key_inline: string;
  default_thinking: string;
  timeout_seconds: string;
}

const EMPTY_DRAFT: ChannelDraft = {
  ref: '',
  provider: 'openai',
  model: '',
  base_url: '',
  api_key_env: '',
  api_key_inline: '',
  default_thinking: 'high',
  timeout_seconds: '120',
};

function draftOf(channel: ModelChannel): ChannelDraft {
  return {
    ref: channel.ref,
    provider: channel.provider,
    model: channel.model,
    base_url: channel.base_url,
    api_key_env: channel.api_key_env,
    api_key_inline: '', // 密钥永不回显：编辑态留空 = 不修改
    default_thinking: channel.default_thinking,
    timeout_seconds: String(channel.timeout_seconds),
  };
}

/** 表单校验：返回字段级错误（空对象 = 通过）。 */
export function validateChannelDraft(
  draft: ChannelDraft,
): Record<keyof ChannelDraft, string> {
  const errors = {} as Record<keyof ChannelDraft, string>;
  if (draft.ref.trim().length === 0) errors.ref = 'form.error.required';
  if (draft.model.trim().length === 0) errors.model = 'form.error.required';
  if (!PROVIDERS.includes(draft.provider)) errors.provider = 'form.error.provider';
  if (!THINKING_LEVELS.includes(draft.default_thinking as never)) {
    errors.default_thinking = 'form.error.thinking';
  }
  const timeout = Number(draft.timeout_seconds);
  if (!Number.isInteger(timeout) || timeout <= 0) errors.timeout_seconds = 'form.error.timeout';
  return errors;
}

export function ChannelsSection(): JSX.Element {
  const t = useTranslate();
  const refreshModelChannels = useAppStore((s) => s.refreshModelChannels);

  const [channels, setChannels] = useState<ModelChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelDraft | null>(null);
  const [editingBase, setEditingBase] = useState<ModelChannel | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [armedDeleteRef, setArmedDeleteRef] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await getApi().listAdminModels();
      setChannels(Array.isArray(list?.models) ? list.models : []);
    } catch (err) {
      // 回退文案走非响应式 translate（保持 reload 引用稳定，避免 effect 循环）
      setLoadError(err instanceof Error ? err.message : translate('settings.channels.loadError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startCreate = (): void => {
    setEditing({ ...EMPTY_DRAFT });
    setEditingBase(null);
    setFormErrors({});
    setSaveError(null);
  };

  const startEdit = (channel: ModelChannel): void => {
    setEditing(draftOf(channel));
    setEditingBase(channel);
    setFormErrors({});
    setSaveError(null);
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    const errors = validateChannelDraft(editing);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const input: ModelChannelInput = {
      ref: editing.ref.trim(),
      provider: editing.provider,
      model: editing.model.trim(),
      base_url: editing.base_url.trim(),
      api_key_env: editing.api_key_env.trim(),
      default_thinking: parseThinkingLevel(editing.default_thinking),
      timeout_seconds: Number(editing.timeout_seconds),
      ...(editing.api_key_inline.length > 0
        ? { api_key_inline: editing.api_key_inline }
        : {}),
    };
    setSaving(true);
    setSaveError(null);
    try {
      await getApi().putAdminModel(input);
      setEditing(null);
      setEditingBase(null);
      await reload();
      await refreshModelChannels();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ref: string): Promise<void> => {
    setDeleteError(null);
    try {
      await getApi().deleteAdminModel(ref);
      setArmedDeleteRef(null);
      await reload();
      await refreshModelChannels();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setArmedDeleteRef(null);
    }
  };

  const fieldError = (key: keyof ChannelDraft): JSX.Element | null =>
    formErrors[key] ? (
      <span className="field-error">{t(formErrors[key])}</span>
    ) : null;

  return (
    <section className="settings-section" data-testid="settings-channels">
      <h3 className="settings-section__title">{t('settings.channels')}</h3>
      <p className="settings-section__desc">{t('settings.channels.desc')}</p>

      {loadError ? (
        <div className="settings-inline-error" role="alert">
          {t('settings.channels.loadError')}：{loadError}
          <button type="button" className="btn btn--sm" onClick={() => void reload()}>
            {t('settings.channels.refresh')}
          </button>
        </div>
      ) : null}

      <div className="channel-actions">
        <button type="button" className="btn btn--sm" onClick={() => void reload()}>
          {t('settings.channels.refresh')}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={startCreate}
          data-testid="channel-new"
        >
          {t('settings.channels.new')}
        </button>
      </div>

      {editing ? (
        <form
          className="channel-form"
          data-testid="channel-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="settings-row">
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-ref">{t('form.ref')}</label>
              <input
                id="channel-ref"
                className="input mono"
                data-testid="channel-form-ref"
                value={editing.ref}
                // 编辑已有渠道时 ref 是主键，禁止改名（等价于新建新渠道）
                disabled={editingBase !== null}
                onChange={(e) => setEditing({ ...editing, ref: e.target.value })}
              />
              {fieldError('ref')}
            </div>
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-provider">{t('form.provider')}</label>
              <select
                id="channel-provider"
                className="select"
                data-testid="channel-form-provider"
                value={editing.provider}
                onChange={(e) =>
                  setEditing({ ...editing, provider: e.target.value as ChannelDraft['provider'] })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              {fieldError('provider')}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-model">{t('form.model')}</label>
              <input
                id="channel-model"
                className="input mono"
                data-testid="channel-form-model"
                value={editing.model}
                onChange={(e) => setEditing({ ...editing, model: e.target.value })}
              />
              {fieldError('model')}
            </div>
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-base">{t('form.baseUrl')}</label>
              <input
                id="channel-base"
                className="input mono"
                value={editing.base_url}
                onChange={(e) => setEditing({ ...editing, base_url: e.target.value })}
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-keyenv">{t('form.apiKeyEnv')}</label>
              <input
                id="channel-keyenv"
                className="input mono"
                value={editing.api_key_env}
                onChange={(e) => setEditing({ ...editing, api_key_env: e.target.value })}
              />
            </div>
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-keyinline">{t('form.apiKeyInline')}</label>
              <input
                id="channel-keyinline"
                className="input mono"
                type="password"
                autoComplete="off"
                data-testid="channel-form-api-key"
                placeholder={t('form.apiKeyInlineHint')}
                value={editing.api_key_inline}
                onChange={(e) => setEditing({ ...editing, api_key_inline: e.target.value })}
              />
              <span className="settings-hint">{t('form.apiKeyInlineHint')}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-thinking">{t('form.defaultThinking')}</label>
              <select
                id="channel-thinking"
                className="select"
                value={editing.default_thinking}
                onChange={(e) => setEditing({ ...editing, default_thinking: e.target.value })}
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>{t(`thinking.${level}`)}</option>
                ))}
              </select>
              {fieldError('default_thinking')}
            </div>
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="channel-timeout">{t('form.timeout')}</label>
              <input
                id="channel-timeout"
                className="input mono"
                data-testid="channel-form-timeout"
                value={editing.timeout_seconds}
                onChange={(e) => setEditing({ ...editing, timeout_seconds: e.target.value })}
              />
              {fieldError('timeout_seconds')}
            </div>
          </div>

          {saveError ? (
            <div className="settings-inline-error" role="alert">{saveError}</div>
          ) : null}

          <div className="channel-form__actions">
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              data-testid="channel-form-save"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? t('form.saving') : t('form.save')}
            </button>
          </div>
        </form>
      ) : null}

      {deleteError ? (
        <div className="settings-inline-error" role="alert">{deleteError}</div>
      ) : null}

      {loading && channels.length === 0 ? (
        <div className="skeleton" style={{ height: '64px' }} aria-busy="true" />
      ) : channels.length === 0 ? (
        <p className="settings-hint">{t('settings.channels.empty')}</p>
      ) : (
        <table className="channel-table" data-testid="channel-table">
          <thead>
            <tr>
              <th>{t('settings.channels.col.ref')}</th>
              <th>{t('settings.channels.col.provider')}</th>
              <th>{t('settings.channels.col.model')}</th>
              <th>{t('settings.channels.col.baseUrl')}</th>
              <th>{t('settings.channels.col.key')}</th>
              <th>{t('settings.channels.col.thinking')}</th>
              <th>{t('settings.channels.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.ref} data-testid={`channel-row-${c.ref}`}>
                <td className="mono">{c.ref}</td>
                <td className="mono">{c.provider}</td>
                <td className="mono">{c.model}</td>
                <td className="mono">{c.base_url || '—'}</td>
                <td className={c.has_api_key ? 'channel-key--set' : 'channel-key--unset'}>
                  {c.has_api_key ? `√ ${t('settings.channels.keySet')}` : t('settings.channels.keyUnset')}
                </td>
                <td>{t(`thinking.${parseThinkingLevel(c.default_thinking)}`)}</td>
                <td>
                  <div className="channel-actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => startEdit(c)}
                    >
                      {t('settings.channels.edit')}
                    </button>
                    {armedDeleteRef === c.ref ? (
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        data-testid={`channel-delete-confirm-${c.ref}`}
                        title={t('settings.channels.deleteConfirm', { ref: c.ref })}
                        onClick={() => void remove(c.ref)}
                      >
                        {t('settings.channels.delete')}?
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setArmedDeleteRef(c.ref)}
                      >
                        {t('settings.channels.delete')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
