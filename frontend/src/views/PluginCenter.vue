<!--
  插件中心（应用内）—— 数据来自平台 http://platform.fufumidi.de5.net 的
  /api/store/manifest/{channel}，由主进程代取（见 main/plugins.js 的 plugins:catalog）。
  下载与安装走既有的两段式 IPC：installFromPlatform（只下载 + 回报包内清单）→ confirmInstall
  （用户看清包里有什么之后再解压落地、重扫插件、立即可用）。

  ★ 为什么不在应用里用 <webview>/iframe 直接嵌平台页面：
    平台页面会自己发起下载（浏览器行为），装不进应用的插件目录；而插件是本地可信代码，
    必须在解压前把清单摊给用户看。所以这里只取**目录数据**，下载与安装仍走主进程。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { t } from '../core/i18n.js';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const toast = (m: string, kind?: string) => app.toast(m, kind as any);

const loading = ref(false);
const err = ref('');
const url = ref('');
const plugins = ref<any[]>([]);
const channel = ref<'stable' | 'beta'>('stable');
const busySlug = ref('');
const confirm = ref<any>(null);          // 待确认的安装（含包内清单）
const installed = ref<any[]>([]);
/* 两个页签：插件中心（平台目录）/ 已安装（原来的「设置 → 插件」页，整页搬到这里） */
const tab = ref<'store' | 'installed'>('store');
const localPlugins = ref<any[]>([]);     // 本地插件宿主列表（含内置）
const pluginLog = ref('');

const bridge = window.fuBridge as any;

async function load() {
  if (!bridge || typeof bridge.plugins?.catalog !== 'function') { err.value = t('当前版本不支持插件中心'); return; }
  loading.value = true;
  err.value = '';
  try {
    const r = await bridge.plugins.catalog(channel.value);
    if (!r || !r.ok) { err.value = (r && r.error) || t('加载插件中心失败'); plugins.value = []; return; }
    url.value = r.url || '';
    plugins.value = r.plugins || [];
    const il = await bridge.plugins.installedList().catch(() => null);
    installed.value = (il && il.plugins) || [];
  } catch (e: any) {
    err.value = String((e && e.message) || e);
  } finally { loading.value = false; }
}

/** 已装版本（按 id 匹配，平台 slug 与插件 id 通常一致） */
function installedVersion(p: any) {
  const hit = installed.value.find((x) => x.id === p.slug || x.id === (p.manifest && p.manifest.id));
  return hit ? hit.version : '';
}
function isInstalled(p: any) { return !!installedVersion(p); }
function hasUpdate(p: any) {
  const v = installedVersion(p);
  return !!v && String(v) !== String(p.version);
}
function human(n: number) {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 第一步：下载到缓存并回报包内清单（不落地） */
async function download(p: any) {
  busySlug.value = p.slug;
  try {
    const r = await bridge.plugins.installFromPlatform(p.slug, p.version);
    if (!r || !r.ok) { toast((r && r.error) || t('下载失败'), 'bad'); return; }
    confirm.value = { p, token: r.token, manifest: r.manifest || {}, files: r.files || [], overwrite: isInstalled(p) };
  } catch (e: any) { toast(String((e && e.message) || e), 'bad'); }
  finally { busySlug.value = ''; }
}

/** 第二步：用户确认后解压安装，装完主进程会重扫插件，立即可用 */
async function doInstall() {
  const c = confirm.value;
  if (!c) return;
  busySlug.value = c.p.slug;
  try {
    const r = await bridge.plugins.confirmInstall(c.token, c.overwrite);
    if (!r || !r.ok) { toast((r && r.error) || t('安装失败'), 'bad'); return; }
    toast(t('已安装并启用：') + (r.manifest?.name || r.id), 'ok');
    confirm.value = null;
    await load();
    await bridge.plugins.setEnabled?.(r.id, true);
    await bridge.plugins.rescan?.();
  } catch (e: any) { toast(String((e && e.message) || e), 'bad'); }
  finally { busySlug.value = ''; }
}

function cancel() {
  const c = confirm.value;
  if (c && bridge.plugins.cancelInstall) bridge.plugins.cancelInstall(c.token);
  confirm.value = null;
}

/* ---------------- 已安装（原「设置 → 插件」页） ---------------- */
async function loadLocal() {
  if (!bridge || !bridge.plugins) return;
  try { localPlugins.value = await bridge.plugins.list() || []; } catch (e) { localPlugins.value = []; }
}
async function togglePlugin(p: any) {
  try { await bridge.plugins.setEnabled(p.id, p.enabled); } catch (e) { p.enabled = !p.enabled; }
}
async function rescanPlugins() {
  try { localPlugins.value = await bridge.plugins.rescan() || []; } catch (e) { /* 忽略 */ }
  toast(t('已重新扫描插件目录'), 'ok');
}
function openPluginDir() { if (bridge.plugins.openDir) bridge.plugins.openDir(); }
function openDocs() { if (bridge.plugins.openDocs) bridge.plugins.openDocs(); }

let offLog: any = null;
onMounted(async () => {
  await Promise.all([load(), loadLocal()]);
  // 插件日志：原来的设置页里也有，搬过来一起显示
  if (bridge.plugins.onLog) {
    offLog = bridge.plugins.onLog((p: any) => {
      const line = p && p.line != null ? String(p.line) : JSON.stringify(p || '');
      pluginLog.value = (pluginLog.value ? pluginLog.value + '\n' : '') + line;
      if (pluginLog.value.length > 8000) pluginLog.value = pluginLog.value.slice(-8000);
    });
  }
});
onBeforeUnmount(() => { if (offLog) { try { offLog(); } catch (e) {} offLog = null; } });
</script>

<template>
  <div class="pc">
    <div class="pc-head">
      <Icon name="extension" :size="16" />
      <b>{{ t('插件中心') }}</b>
      <span class="muted small">{{ t('从官方插件平台浏览并一键安装；下载后由应用解压到插件目录并立即启用') }}</span>
      <span class="sp" />
      <template v-if="tab === 'store'">
        <select class="pc-ch" :value="channel" @change="channel = ($event.target as HTMLSelectElement).value as any; load()">
          <option value="stable">{{ t('正式通道') }}</option>
          <option value="beta">{{ t('测试通道') }}</option>
        </select>
        <button class="btn sm" :disabled="loading" @click="load">
          <Icon name="refresh" :size="12" /> {{ loading ? t('加载中…') : t('刷新') }}
        </button>
      </template>
      <template v-else>
        <button class="btn sm" @click="openPluginDir">{{ t('打开插件目录') }}</button>
        <a class="pc-docs" @click="openDocs">{{ t('开发者文档') }} ↗</a>
        <button class="btn sm" @click="rescanPlugins">{{ t('重新扫描') }}</button>
      </template>
    </div>

    <!-- 页签：插件中心 / 已安装（原「设置 → 插件」页整页搬来，设置里不再重复） -->
    <div class="pc-tabs">
      <button class="pc-tab" :class="{ on: tab === 'store' }" @click="tab = 'store'">
        <Icon name="extension" :size="13" /> {{ t('插件中心') }}
      </button>
      <button class="pc-tab" :class="{ on: tab === 'installed' }" @click="tab = 'installed'">
        <Icon name="box" :size="13" /> {{ t('已安装') }}（{{ localPlugins.length }}）
      </button>
    </div>

    <!-- ============ 已安装：本地插件开关 / 日志 / 目录入口 ============ -->
    <template v-if="tab === 'installed'">
      <p class="muted small pc-note">
        {{ t('插件目录：') }}<b>{{ t('用户目录/fufumidi/plugins/<插件名>/') }}</b>
        {{ t('，内含 plugin.json 与入口脚本；开关立即生效。插件等同本地可信代码。') }}
      </p>
      <div v-if="!localPlugins.length" class="pc-empty">{{ t('还没有安装任何插件') }}</div>
      <div v-for="p in localPlugins" :key="p.id" class="pc-inst">
        <div class="pc-inst-info">
          <b>{{ p.name }} <span class="muted small">v{{ p.version }}</span></b>
          <small>{{ p.description || p.id }}</small>
        </div>
        <span class="pc-badge" :class="{ on: p.enabled }">{{ p.enabled ? t('已启用') : t('已禁用') }}</span>
        <label class="pc-switch">
          <input type="checkbox" :checked="p.enabled" @change="(e) => { p.enabled = (e.target as HTMLInputElement).checked; togglePlugin(p); }" />
          <span></span>
        </label>
      </div>
      <div class="pc-log-head">{{ t('插件日志') }}</div>
      <div class="pc-log">{{ pluginLog || t('无') }}</div>
    </template>

    <p v-if="tab === 'store' && err" class="pc-err small">
      <Icon name="info" :size="13" /> {{ err }}
      <span v-if="url" class="muted">（{{ url }}）</span>
    </p>
    <p v-else-if="tab === 'store' && !loading && !plugins.length" class="pc-err small muted">{{ t('插件中心目前没有上架的插件') }}</p>

    <div v-if="tab === 'store'" class="pc-grid">
      <div v-for="p in plugins" :key="p.slug" class="pc-card">
        <div class="pc-ic">
          <img v-if="p.icon" :src="p.icon" alt="" />
          <Icon v-else name="extension" :size="20" />
        </div>
        <div class="pc-body">
          <div class="pc-name">
            <b>{{ p.name || p.slug }}</b>
            <span class="pc-ver">v{{ p.version }}</span>
            <span v-if="isInstalled(p)" class="pc-badge on">{{ hasUpdate(p) ? t('可更新') : t('已安装') }}</span>
          </div>
          <div class="pc-sum">{{ p.summary || (p.manifest && p.manifest.description) || '' }}</div>
          <div class="pc-meta muted small">
            <span v-if="p.category">{{ p.category }}</span>
            <span v-if="p.size">· {{ human(p.size) }}</span>
            <span v-if="p.downloads != null">· {{ p.downloads }} {{ t('次下载') }}</span>
            <span v-if="p.manifest && p.manifest.author">· {{ p.manifest.author }}</span>
          </div>
        </div>
        <button class="btn sm primary" :disabled="busySlug === p.slug" @click="download(p)">
          <Icon name="download" :size="12" />
          {{ busySlug === p.slug ? t('下载中…') : (isInstalled(p) ? (hasUpdate(p) ? t('更新') : t('重新安装')) : t('下载并安装')) }}
        </button>
      </div>
    </div>

    <!-- 安装确认：把包内清单摊开（平台目前没有发布签名，这一步不能省） -->
    <div v-if="confirm" class="pc-mask" @click.self="cancel">
      <div class="pc-dlg">
        <div class="pc-dlg-head"><Icon name="box" :size="15" /><b>{{ t('确认安装插件') }}</b></div>
        <div class="pc-dlg-body">
          <div class="pc-kv"><span>{{ t('名称') }}</span><b>{{ confirm.manifest.name || confirm.p.slug }}</b></div>
          <div class="pc-kv"><span>{{ t('版本') }}</span><b>{{ confirm.manifest.version || confirm.p.version }}</b></div>
          <div class="pc-kv"><span>{{ t('作者') }}</span><b>{{ confirm.manifest.author || '—' }}</b></div>
          <div class="pc-kv"><span>{{ t('入口') }}</span><b>{{ confirm.manifest.entry || 'index.js' }}</b></div>
          <p class="pc-desc muted small">{{ confirm.manifest.description || confirm.p.summary || '' }}</p>
          <p v-if="confirm.files.length" class="muted small">
            {{ t('包内文件（') }}{{ confirm.files.length }}{{ t(' 个）：') }}{{ confirm.files.slice(0, 12).join('、') }}{{ confirm.files.length > 12 ? ' …' : '' }}
          </p>
          <p class="pc-warn small">{{ t('插件等同本地可信代码，会在独立 worker 中运行；确认来源可信后再安装。') }}</p>
        </div>
        <div class="pc-dlg-foot">
          <button class="btn sm" @click="cancel">{{ t('取消') }}</button>
          <button class="btn sm primary" :disabled="!!busySlug" @click="doInstall">
            {{ confirm.overwrite ? t('覆盖安装') : t('安装') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pc { height: 100%; overflow: auto; background: var(--canvas); padding: 12px 16px 18px; }
.pc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.pc-head b { font-size: 14px; }
.pc-head .sp { flex: 1; }
.pc-ch { height: 26px; border: 1px solid var(--hairline); border-radius: 7px; background: var(--surface); color: var(--ink); font-size: 12px; }
.pc-err { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; color: var(--brand-coral); }
.pc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-top: 12px; }
.pc-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--border);
           border-radius: 12px; background: var(--surface); }
.pc-ic { width: 40px; height: 40px; flex: none; border-radius: 10px; display: grid; place-items: center;
         background: var(--surface-soft); overflow: hidden; }
.pc-ic img { width: 100%; height: 100%; object-fit: cover; }
.pc-body { flex: 1; min-width: 0; }
.pc-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pc-name b { font-size: 13.5px; }
.pc-ver { font-size: 11px; color: var(--stone); font-family: var(--mono); }
.pc-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 20px; border: 1px solid var(--border); }
.pc-badge.on { border-color: var(--success-text, #22c55e); color: var(--success-text, #22c55e); }
.pc-sum { font-size: 12px; color: var(--slate); margin-top: 2px; }
.pc-meta { margin-top: 3px; }
/* ---- 页签与「已安装」面板（原设置页的插件页样式搬过来） ---- */
.pc-tabs { display: flex; gap: 6px; margin-top: 12px; }
.pc-tab { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 13px; cursor: pointer;
          border: 1px solid var(--border); background: var(--surface); color: var(--slate);
          border-radius: 9px; font-size: 12.5px; }
.pc-tab:hover { color: var(--ink); }
.pc-tab.on { background: var(--surface-soft); color: var(--ink); border-color: var(--hairline); font-weight: 600; }
.pc-note { margin: 12px 0 0; line-height: 1.8; }
.pc-note b { font-family: var(--mono); font-size: 11.5px; color: var(--ink); }
.pc-empty { margin-top: 14px; padding: 26px; text-align: center; color: var(--stone); font-size: 12.5px;
            border: 1px dashed var(--border); border-radius: 12px; }
.pc-inst { display: flex; align-items: center; gap: 12px; margin-top: 10px; padding: 11px 14px;
           border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.pc-inst-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-inst-info b { font-size: 13px; }
.pc-inst-info small { color: var(--slate); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-switch { position: relative; width: 36px; height: 20px; flex: none; cursor: pointer; }
.pc-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.pc-switch span { position: absolute; inset: 0; border-radius: 20px; background: var(--hairline); transition: background .15s; }
.pc-switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
                         background: var(--canvas); transition: transform .15s; }
.pc-switch input:checked + span { background: var(--brand-coral); }
.pc-switch input:checked + span::after { transform: translateX(16px); }
.pc-log-head { margin: 16px 0 6px; font-size: 12.5px; font-weight: 600; }
.pc-log { max-height: 180px; overflow: auto; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
          background: var(--surface-soft); color: var(--slate); font-family: var(--mono); font-size: 11.5px;
          line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
.pc-docs { font-size: 12px; color: var(--brand-coral); cursor: pointer; }
.pc-docs:hover { text-decoration: underline; }
.pc-mask { position: fixed; inset: 0; background: rgba(8, 10, 16, .45); z-index: 120; display: grid; place-items: center; padding: 24px; }
.pc-dlg { width: 460px; max-width: 94vw; background: var(--canvas); border: 1px solid var(--border);
          border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,.3); overflow: hidden; }
.pc-dlg-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.pc-dlg-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.pc-kv { display: flex; gap: 10px; font-size: 12.5px; }
.pc-kv span { width: 56px; flex: none; color: var(--stone); }
.pc-desc { margin: 6px 0 0; line-height: 1.7; }
.pc-warn { margin: 6px 0 0; color: var(--brand-coral); }
.pc-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
</style>
