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

const CACHE_KEY = 'fufumidi_plugin_catalog_v1';
const cachedCatalog = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; } })();
const catalogFresh = !!(cachedCatalog && cachedCatalog.at && Date.now() - Number(cachedCatalog.at) < 10 * 60 * 1000 && Array.isArray(cachedCatalog.plugins));
const loading = ref(!catalogFresh);
const err = ref('');
const url = ref((cachedCatalog && cachedCatalog.url) || '');
const plugins = ref<any[]>((cachedCatalog && Array.isArray(cachedCatalog.plugins)) ? cachedCatalog.plugins : []);
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
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ url: url.value, plugins: plugins.value, at: Date.now() })); } catch (e) {}
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
/* 插件网（第三方作者的发布入口）：只允许打开平台域名下的相对路径，主进程侧也做了白名单 */
const platformHost = ref('');
async function openPlatform(rel: string) {
  try {
    const r = bridge.plugins.openPlatform ? await bridge.plugins.openPlatform(rel) : null;
    if (!r || !r.ok) toast(t('打开插件网失败'), 'bad');
  } catch (e: any) { toast(String((e && e.message) || e), 'bad'); }
}
async function loadPlatformInfo() {
  try {
    const r = bridge.plugins.platformInfo ? await bridge.plugins.platformInfo() : null;
    if (r && r.ok && r.host) platformHost.value = String(r.host);
  } catch (e) { /* 拿不到就不显示 */ }
}

let offLog: any = null;
onMounted(async () => {
  await Promise.all([loadLocal(), loadPlatformInfo()]);
  if (!catalogFresh) await load();
  else if (bridge.plugins?.installedList) { try { const il = await bridge.plugins.installedList(); installed.value = (il && il.plugins) || []; } catch (e) {} }
  // 有缓存时不重复请求网络；刷新按钮 / 切通道仍会 load()
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
    <section class="pc-hero">
      <div class="pc-hero-emblem"><Icon name="extension" :size="24" /></div>
      <div class="pc-hero-copy">
        <div class="pc-kicker">{{ t('资源中心 · 扩展能力') }}</div>
        <h2>{{ t('插件中心') }}</h2>
        <p>{{ t('从官方插件平台浏览并安装扩展；安装完成并重扫后立即启用。') }}</p>
      </div>
      <div class="pc-hero-stats">
        <div class="pc-stat"><b>{{ localPlugins.length }}</b><span>{{ t('已安装') }}</span></div>
        <div class="pc-stat"><b>{{ loading ? '…' : plugins.length }}</b><span>{{ t('平台上架') }}</span></div>
        <div class="pc-stat pc-stat-ch"><b>{{ channel === 'beta' ? 'BETA' : 'STABLE' }}</b><span>{{ t('当前通道') }}</span></div>
      </div>
    </section>

    <div class="pc-toolbar">
      <div class="pc-tabs">
        <button class="pc-tab" :class="{ on: tab === 'store' }" @click="tab = 'store'">
          <Icon name="extension" :size="14" /> {{ t('插件中心') }}
          <span class="pc-tab-count">{{ loading ? '…' : plugins.length }}</span>
        </button>
        <button class="pc-tab" :class="{ on: tab === 'installed' }" @click="tab = 'installed'">
          <Icon name="box" :size="14" /> {{ t('已安装') }}
          <span class="pc-tab-count">{{ localPlugins.length }}</span>
        </button>
      </div>
      <div class="pc-actions">
        <template v-if="tab === 'store'">
          <select class="pc-ch" :value="channel" @change="channel = ($event.target as HTMLSelectElement).value as any; load()">
            <option value="stable">{{ t('正式通道') }}</option>
            <option value="beta">{{ t('测试通道') }}</option>
          </select>
          <button class="btn sm" :disabled="loading" @click="load">
            <Icon name="refresh" :size="13" /> {{ loading ? t('加载中…') : t('刷新') }}
          </button>
        </template>
        <template v-else>
          <button class="btn sm" @click="openPluginDir"><Icon name="folder" :size="13" /> {{ t('打开插件目录') }}</button>
          <a class="pc-docs" @click="openDocs"><Icon name="info" :size="13" /> {{ t('开发者文档') }} ↗</a>
          <button class="btn sm" @click="rescanPlugins"><Icon name="refresh" :size="13" /> {{ t('重新扫描') }}</button>
        </template>
      </div>
    </div>

    <template v-if="tab === 'installed'">
      <div class="pc-note">
        <Icon name="info" :size="15" />
        <div>
          <b>{{ t('插件目录') }}</b>
          <span>{{ t('用户目录/fufumidi/plugins/<插件名>/，内含 plugin.json 与入口脚本；开关立即生效。插件等同本地可信代码。') }}</span>
        </div>
      </div>
      <div v-if="!localPlugins.length" class="pc-empty">
        <div class="pc-empty-ic"><Icon name="box" :size="22" /></div>
        <b>{{ t('还没有安装任何插件') }}</b>
        <p>{{ t('去插件中心挑一个，或把插件文件夹放进插件目录后点「重新扫描」。') }}</p>
        <button class="btn sm" @click="tab = 'store'"><Icon name="extension" :size="13" /> {{ t('去插件中心') }}</button>
      </div>
      <div v-else class="pc-inst-list">
        <div v-for="p in localPlugins" :key="p.id" class="pc-inst">
          <div class="pc-inst-ic"><Icon name="extension" :size="18" /></div>
          <div class="pc-inst-info">
            <div class="pc-inst-title"><b>{{ p.name }}</b><span class="pc-ver">v{{ p.version }}</span><span class="pc-badge" :class="{ on: p.enabled }">{{ p.enabled ? t('已启用') : t('已禁用') }}</span></div>
            <small>{{ p.description || p.id }}</small>
          </div>
          <label class="pc-switch" :title="p.enabled ? t('点击禁用') : t('点击启用')">
            <input type="checkbox" :checked="p.enabled" @change="(e) => { p.enabled = (e.target as HTMLInputElement).checked; togglePlugin(p); }" />
            <span></span>
          </label>
        </div>
      </div>
      <section class="pc-log-card">
        <div class="pc-log-head"><Icon name="list" :size="14" /><b>{{ t('插件日志') }}</b><span class="pc-log-dot"></span></div>
        <div class="pc-log">{{ pluginLog || t('暂无日志') }}</div>
      </section>
    </template>

    <template v-else>
      <div class="pc-net">
        <div class="pc-net-ic"><Icon name="extension" :size="18" /></div>
        <div class="pc-net-tx">
          <b>{{ t('插件网') }}</b>
          <small>{{ t('第三方作者在这里上传、更新与维护插件；上架后就会出现在下方列表里。') }}</small>
          <small v-if="platformHost" class="pc-net-host">{{ platformHost }}</small>
        </div>
        <div class="pc-net-act">
          <button class="btn sm primary" @click="openPlatform('/upload')"><Icon name="import" :size="13" /> {{ t('上传插件 ↗') }}</button>
          <button class="btn sm" @click="openPlatform('/')">{{ t('打开插件网 ↗') }}</button>
        </div>
      </div>

      <div v-if="err" class="pc-alert">
        <Icon name="info" :size="15" />
        <div><b>{{ t('插件中心暂时不可用') }}</b><span>{{ err }}</span><em v-if="url">{{ url }}</em></div>
        <button class="btn sm" @click="load">{{ t('重试') }}</button>
      </div>

      <div v-if="loading && !plugins.length" class="pc-grid">
        <div v-for="i in 4" :key="i" class="pc-card pc-skel"><i></i><i></i><i></i></div>
      </div>
      <div v-else-if="!plugins.length && !err" class="pc-empty">
        <div class="pc-empty-ic"><Icon name="extension" :size="22" /></div>
        <b>{{ t('插件中心目前没有上架的插件') }}</b>
        <p>{{ t('切换测试通道，或稍后刷新重试。') }}</p>
        <button class="btn sm" @click="load"><Icon name="refresh" :size="13" /> {{ t('刷新') }}</button>
      </div>

      <div v-else class="pc-grid">
        <article v-for="p in plugins" :key="p.slug" class="pc-card">
          <div class="pc-card-top">
            <div class="pc-ic">
              <img v-if="p.icon" :src="p.icon" alt="" />
              <Icon v-else name="extension" :size="22" />
            </div>
            <div class="pc-name">
              <b>{{ p.name || p.slug }}</b>
              <span class="pc-ver">v{{ p.version }}</span>
              <span v-if="isInstalled(p)" class="pc-badge on">{{ hasUpdate(p) ? t('可更新') : t('已安装') }}</span>
            </div>
          </div>
          <p class="pc-sum">{{ p.summary || (p.manifest && p.manifest.description) || t('暂无简介') }}</p>
          <div class="pc-meta">
            <span v-if="p.category" class="pc-chip">{{ p.category }}</span>
            <span v-if="p.size">{{ human(p.size) }}</span>
            <span v-if="p.downloads != null">{{ p.downloads }} {{ t('次下载') }}</span>
            <span v-if="p.manifest && p.manifest.author">{{ p.manifest.author }}</span>
          </div>
          <div class="pc-card-foot">
            <span class="pc-author">{{ p.manifest && p.manifest.author ? p.manifest.author : p.slug }}</span>
            <button class="btn sm primary" :disabled="busySlug === p.slug" @click="download(p)">
              <Icon name="download" :size="13" />
              {{ busySlug === p.slug ? t('下载中…') : (isInstalled(p) ? (hasUpdate(p) ? t('更新') : t('重新安装')) : t('下载并安装')) }}
            </button>
          </div>
        </article>
      </div>
    </template>

    <div v-if="confirm" class="pc-mask" @click.self="cancel">
      <div class="pc-dlg">
        <div class="pc-dlg-head">
          <span class="pc-dlg-ic"><Icon name="box" :size="17" /></span>
          <div><b>{{ t('确认安装插件') }}</b><small>{{ t('请确认包内清单与来源') }}</small></div>
          <button class="pc-x" @click="cancel" :aria-label="t('关闭')"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div class="pc-dlg-body">
          <div class="pc-kv"><span>{{ t('名称') }}</span><b>{{ confirm.manifest.name || confirm.p.slug }}</b></div>
          <div class="pc-kv"><span>{{ t('版本') }}</span><b>{{ confirm.manifest.version || confirm.p.version }}</b></div>
          <div class="pc-kv"><span>{{ t('作者') }}</span><b>{{ confirm.manifest.author || '—' }}</b></div>
          <div class="pc-kv"><span>{{ t('入口') }}</span><b>{{ confirm.manifest.entry || 'index.js' }}</b></div>
          <p class="pc-desc">{{ confirm.manifest.description || confirm.p.summary || '' }}</p>
          <p v-if="confirm.files.length" class="pc-files">{{ t('包内文件（') }}{{ confirm.files.length }}{{ t(' 个）：') }}{{ confirm.files.slice(0, 12).join('、') }}{{ confirm.files.length > 12 ? ' …' : '' }}</p>
          <p class="pc-warn"><Icon name="info" :size="14" /> {{ t('插件等同本地可信代码，会在独立 worker 中运行；确认来源可信后再安装。') }}</p>
        </div>
        <div class="pc-dlg-foot">
          <button class="btn sm" @click="cancel">{{ t('取消') }}</button>
          <button class="btn sm primary" :disabled="!!busySlug" @click="doInstall">{{ confirm.overwrite ? t('覆盖安装') : t('安装') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 插件中心：嵌入资源中心，使用统一卡片/标签/表格语言 ===== */
.pc { display: flex; flex-direction: column; gap: 14px; }

.pc-hero { display: flex; align-items: center; gap: 16px; padding: 20px 22px; border: 1px solid var(--hairline); border-radius: var(--r-lg); background: linear-gradient(120deg, color-mix(in srgb, var(--accent-sapphire) 16%, var(--surface)), color-mix(in srgb, var(--accent-sky) 6%, var(--surface)) 55%, var(--surface)); box-shadow: var(--shadow-sm); }
.pc-hero-emblem { width: 52px; height: 52px; flex: none; display: grid; place-items: center; border-radius: 15px; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sky) 14%, transparent); border: 1px solid color-mix(in srgb, var(--accent-sky) 24%, transparent); }
.pc-hero-copy { min-width: 0; }
.pc-kicker { font-size: var(--fs-xs); letter-spacing: .16em; text-transform: uppercase; color: var(--accent-sky); margin-bottom: 3px; }
.pc-hero h2 { margin: 0; font-size: var(--fs-xl); color: var(--text); line-height: 1.25; }
.pc-hero p { margin: 5px 0 0; color: var(--text2); font-size: var(--fs-md); line-height: 1.6; }
.pc-hero-stats { display: flex; align-items: stretch; gap: 8px; margin-left: auto; flex: none; }
.pc-stat { min-width: 76px; padding: 8px 12px; border-radius: var(--r-md); border: 1px solid var(--hairline); background: color-mix(in srgb, var(--canvas) 52%, transparent); display: flex; flex-direction: column; gap: 1px; }
.pc-stat b { font-size: var(--fs-lg); color: var(--text); line-height: 1.2; font-family: var(--font-num, var(--mono)); }
.pc-stat span { font-size: var(--fs-xs); color: var(--text3); }
.pc-stat-ch b { color: var(--accent-sky); font-size: var(--fs-sm); letter-spacing: .06em; }

.pc-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px; border: 1px solid var(--hairline); border-radius: var(--r-lg); background: color-mix(in srgb, var(--surface) 72%, transparent); }
.pc-tabs { display: flex; gap: 2px; }
.pc-tab { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px; border: 0; border-radius: var(--r-md); background: transparent; color: var(--text2); font-size: var(--fs-md); cursor: pointer; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
.pc-tab:hover { background: color-mix(in srgb, var(--accent-sky) 8%, transparent); color: var(--text); }
.pc-tab.on { background: color-mix(in srgb, var(--accent-sapphire) 22%, var(--surface)); color: var(--text); font-weight: 600; }
.pc-tab-count { min-width: 19px; padding: 0 6px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--canvas) 60%, transparent); color: var(--text3); font-size: var(--fs-xs); line-height: 18px; text-align: center; font-family: var(--font-num, var(--mono)); }
.pc-tab.on .pc-tab-count { color: var(--accent-sky); }
.pc-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.pc-ch { height: 30px; padding: 0 8px; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface); color: var(--text); font-size: var(--fs-sm); }
.pc-docs { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--accent-sky); cursor: pointer; }
.pc-docs:hover { text-decoration: underline; }

.pc-net { display: flex; align-items: center; gap: 13px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--accent-sky) 22%, var(--hairline)); border-radius: var(--r-lg); background: linear-gradient(100deg, color-mix(in srgb, var(--accent-sky) 10%, var(--surface)), var(--surface) 65%); }
.pc-net-ic { width: 38px; height: 38px; flex: none; border-radius: var(--r-md); display: grid; place-items: center; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sky) 13%, transparent); }
.pc-net-tx { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-net-tx b { font-size: var(--fs-md); color: var(--text); }
.pc-net-tx small { color: var(--text2); font-size: var(--fs-sm); line-height: 1.5; }
.pc-net-host { font-family: var(--font-num, var(--mono)); color: var(--text3) !important; font-size: var(--fs-xs) !important; }
.pc-net-act { margin-left: auto; display: flex; gap: 8px; flex: none; }

.pc-alert { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--brand-coral) 34%, var(--hairline)); border-radius: var(--r-md); background: color-mix(in srgb, var(--brand-coral) 8%, var(--surface)); color: var(--text); }
.pc-alert > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-alert b { font-size: var(--fs-md); }
.pc-alert span { color: var(--text2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.pc-alert em { color: var(--text3); font-size: var(--fs-xs); font-style: normal; overflow-wrap: anywhere; }
.pc-alert .btn { margin-left: auto; flex: none; }

.pc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 12px; }
.pc-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--hairline); border-radius: var(--r-lg); background: color-mix(in srgb, var(--surface) 78%, transparent); min-width: 0; transition: border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.pc-card:hover { border-color: color-mix(in srgb, var(--accent-sky) 30%, var(--hairline)); transform: translateY(-1px); }
.pc-card-top { display: flex; align-items: center; gap: 11px; min-width: 0; }
.pc-ic { width: 42px; height: 42px; flex: none; border-radius: var(--r-md); display: grid; place-items: center; background: color-mix(in srgb, var(--accent-sky) 9%, var(--surface-soft)); color: var(--accent-sky); overflow: hidden; }
.pc-ic img { width: 100%; height: 100%; object-fit: cover; }
.pc-name { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.pc-name b { font-size: var(--fs-md); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pc-ver { font-size: var(--fs-xs); color: var(--text3); font-family: var(--font-num, var(--mono)); }
.pc-badge { font-size: var(--fs-xs); padding: 0 7px; border-radius: var(--r-pill); border: 1px solid var(--hairline); color: var(--text3); line-height: 18px; }
.pc-badge.on { border-color: color-mix(in srgb, var(--success-text, var(--t-ok)) 38%, transparent); color: var(--success-text, var(--t-ok)); background: color-mix(in srgb, var(--success-text, var(--t-ok)) 8%, transparent); }
.pc-sum { margin: 0; min-height: 38px; color: var(--text2); font-size: var(--fs-sm); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pc-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; color: var(--text3); font-size: var(--fs-xs); margin-top: auto; }
.pc-chip { padding: 0 6px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--accent-sky) 9%, transparent); color: var(--accent-sky); line-height: 18px; }
.pc-card-foot { display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid var(--hairline); }
.pc-author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text3); font-size: var(--fs-xs); flex: 1; }
.pc-card-foot .btn { flex: none; }

.pc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 42px 20px; border: 1px dashed var(--hairline); border-radius: var(--r-lg); background: color-mix(in srgb, var(--surface) 48%, transparent); text-align: center; }
.pc-empty-ic { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; color: var(--text3); background: color-mix(in srgb, var(--surface) 70%, transparent); }
.pc-empty b { color: var(--text); font-size: var(--fs-md); }
.pc-empty p { margin: 0; color: var(--text3); font-size: var(--fs-sm); max-width: 460px; }
.pc-empty .btn { margin-top: 4px; }

.pc-note { display: flex; align-items: flex-start; gap: 10px; padding: 11px 14px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 62%, transparent); color: var(--text2); }
.pc-note > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pc-note b { color: var(--text); font-size: var(--fs-sm); }
.pc-note span { font-size: var(--fs-sm); line-height: 1.55; }
.pc-inst-list { display: flex; flex-direction: column; gap: 8px; }
.pc-inst { display: flex; align-items: center; gap: 12px; padding: 13px 15px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 72%, transparent); }
.pc-inst-ic { width: 36px; height: 36px; flex: none; border-radius: var(--r-sm); display: grid; place-items: center; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sky) 9%, transparent); }
.pc-inst-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-inst-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.pc-inst-title b { font-size: var(--fs-md); color: var(--text); }
.pc-inst-info small { color: var(--text3); font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-switch { position: relative; width: 38px; height: 21px; flex: none; cursor: pointer; }
.pc-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.pc-switch span { position: absolute; inset: 0; border-radius: var(--r-pill); background: var(--hairline); transition: background var(--motion-fast) var(--ease-out); }
.pc-switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: var(--canvas); transition: transform var(--motion-fast) var(--ease-out); }
.pc-switch input:checked + span { background: var(--accent-sapphire); }
.pc-switch input:checked + span::after { transform: translateX(17px); }

.pc-log-card { border: 1px solid var(--hairline); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 62%, transparent); overflow: hidden; }
.pc-log-head { display: flex; align-items: center; gap: 7px; padding: 10px 14px; border-bottom: 1px solid var(--hairline); color: var(--text); font-size: var(--fs-sm); }
.pc-log-dot { width: 6px; height: 6px; border-radius: 50%; margin-left: auto; background: var(--success-text, var(--t-ok)); opacity: .8; }
.pc-log { max-height: 200px; overflow: auto; padding: 12px 14px; color: var(--text2); font-family: var(--mono); font-size: var(--fs-sm); line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
.pc-skel { min-height: 172px; background: color-mix(in srgb, var(--surface) 52%, transparent); }
.pc-skel i { display: block; height: 12px; border-radius: var(--r-sm); background: linear-gradient(90deg, color-mix(in srgb, var(--surface-soft) 55%, transparent), color-mix(in srgb, var(--surface-soft) 90%, transparent), color-mix(in srgb, var(--surface-soft) 55%, transparent)); background-size: 200% 100%; animation: pcShimmer 1.2s linear infinite; }
.pc-skel i:nth-child(1) { width: 45%; height: 36px; }
.pc-skel i:nth-child(2) { width: 92%; }
.pc-skel i:nth-child(3) { width: 68%; }
@keyframes pcShimmer { from { background-position: 180% 0; } to { background-position: -20% 0; } }

.pc-mask { position: fixed; inset: 0; z-index: 140; display: grid; place-items: center; padding: 24px; background: rgba(4, 10, 18, .55); backdrop-filter: blur(8px); }
.pc-dlg { width: 500px; max-width: 94vw; border: 1px solid var(--hairline); border-radius: var(--r-lg); background: color-mix(in srgb, var(--surface) 96%, var(--canvas)); box-shadow: var(--shadow-lg); overflow: hidden; }
.pc-dlg-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--hairline); }
.pc-dlg-ic { width: 34px; height: 34px; border-radius: var(--r-sm); display: grid; place-items: center; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sky) 12%, transparent); flex: none; }
.pc-dlg-head > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pc-dlg-head b { color: var(--text); font-size: var(--fs-md); }
.pc-dlg-head small { color: var(--text3); font-size: var(--fs-xs); }
.pc-x { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text3); cursor: pointer; display: grid; place-items: center; }
.pc-x:hover { background: var(--surface-soft); color: var(--text); }
.pc-dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 9px; }
.pc-kv { display: flex; gap: 12px; font-size: var(--fs-sm); }
.pc-kv span { width: 48px; flex: none; color: var(--text3); }
.pc-kv b { min-width: 0; color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
.pc-desc { margin: 2px 0 0; color: var(--text2); font-size: var(--fs-sm); line-height: 1.7; }
.pc-files { margin: 0; color: var(--text3); font-size: var(--fs-xs); line-height: 1.6; overflow-wrap: anywhere; }
.pc-warn { display: flex; align-items: flex-start; gap: 7px; margin: 4px 0 0; padding: 9px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--brand-coral) 8%, transparent); color: var(--brand-coral); font-size: var(--fs-xs); line-height: 1.6; }
.pc-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--hairline); background: color-mix(in srgb, var(--canvas) 32%, transparent); }

@media (max-width: 900px) {
  .pc-hero { flex-wrap: wrap; }
  .pc-hero-stats { width: 100%; margin-left: 0; }
  .pc-net { flex-wrap: wrap; }
  .pc-net-act { width: 100%; margin-left: 0; }
  .pc-grid { grid-template-columns: 1fr; }
}
</style>
