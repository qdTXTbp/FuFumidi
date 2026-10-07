<!--
  声库 —— UTAU 与 DiffSinger 的统一入口

  两类声库的**制作/安装/下载**都收在这里，编辑器（ViewSing）只负责「选歌手」，
  不再夹带声库管理。上游 OpenUtau 也是这个分工：声库管理与 sing 编辑器分开。
-->
<script setup lang="ts">
import { computed, onMounted, onActivated, ref } from 'vue';
import Icon from '../components/Icon.vue';
import VoicebankPicker from '../components/utau/VoicebankPicker.vue';
import UtauVoicebankStore from '../components/utau/UtauVoicebankStore.vue';
import { t } from '../core/i18n.js';
import { useDiffsingerStore } from '../stores/diffsinger';
import { useSingerStore } from '../stores/singer';

const ds = useDiffsingerStore();
const singerStore = useSingerStore();

onMounted(() => { void singerStore.loadBanks(); });
// ★ KeepAlive 保活：在模型页装/删了声库后切回来，「已装声库」列表不能停在旧值
onActivated(() => { void singerStore.loadBanks(); });

const busy = ref(false);
const msg = ref('');
const showStore = ref(false);

/**
 * ★ **一份混排列表** —— 不按引擎分区。
 * 引擎只是每条上的一个标签（决定这条能被哪种轨选用），
 * 而不是把声库分成两个互不相干的区域。
 */
const filter = ref<'all' | 'utau' | 'diffsinger'>('all');

// ★ 声库列表只有**一个**来源（singer store 的 `banks`），
//   不再从 utau / diffsinger 两个 store 各取一份再拼。
const allBanks = computed(() => singerStore.banks);
const shown = computed(() =>
  filter.value === 'all' ? allBanks.value : allBanks.value.filter(b => b.engine === filter.value));
/** 某个目录被哪些轨道用着（避免误删正在用的声库） */
const usedIn = (dir: string) => singerStore.bankInUse(dir);

async function refresh() { await singerStore.loadBanks(); }

const dsBusy = computed(() => ds.installing || ds.downloading || ds.msDownloading);
async function run(fn) {
  busy.value = true;
  msg.value = '';
  try { msg.value = (await fn()) || ''; }
  catch (e) { msg.value = String((e && e.message) || e); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="banks">
    <div class="bk-head">
      <Icon name="box" :size="15" />
      <b>{{ t('声库') }}</b>
      <span class="muted small">{{ t('UTAU 与 DiffSinger 的声库都在这里；类型只作标签，不分区') }}</span>
      <span class="sp" />
      <button class="btn" :disabled="busy" @click="run(refresh)">
        <Icon name="refresh" :size="12" /> {{ t('刷新') }}
      </button>
    </div>

    <Transition name="fade">
      <p v-if="msg" class="bk-msg small">{{ msg }}</p>
    </Transition>

    <!-- ============ 已装声库：一份混排列表 ============ -->
    <section class="bk-card" data-guide="banks-installed">
      <div class="bk-title">
        <Icon name="mic" :size="13" /> {{ t('已装声库') }}
        <span class="sp" />
        <span class="seg">
          <button :class="{ on: filter === 'all' }" @click="filter = 'all'">{{ t('全部') }} ({{ allBanks.length }})</button>
          <button :class="{ on: filter === 'utau' }" @click="filter = 'utau'">
            UTAU ({{ allBanks.filter(b => b.engine === 'utau').length }})
          </button>
          <button :class="{ on: filter === 'diffsinger' }" @click="filter = 'diffsinger'">
            DiffSinger ({{ allBanks.filter(b => b.engine === 'diffsinger').length }})
          </button>
        </span>
      </div>

      <p v-if="!shown.length" class="muted small">{{ t('还没有声库。') }}</p>
      <ul v-else class="bk-list">
        <li v-for="b in shown" :key="b.engine + b.dir">
          <span class="tag" :class="'e-' + b.engine">{{ b.engine === 'utau' ? 'UTAU' : 'DS' }}</span>
          <span class="nm">{{ b.name }}</span>
          <span class="muted small">{{ b.dir }}</span>
          <span v-if="usedIn(b.dir)" class="inuse">{{ t('使用中') }}</span>
          <button v-if="b.engine === 'diffsinger'" class="btn danger"
                  :disabled="busy || usedIn(b.dir)"
                  @click="run(async () => {
                    const m = await ds.deleteVoicebank(b.dir);
                    await singerStore.loadBanks();   // 歌手下拉数据源同步，别处不会看到已删声库
                    return m;
                  })">{{ t('删除') }}</button>
          <span v-else class="muted small">{{ t('在 UTAU 声库管理器里删除') }}</span>
        </li>
      </ul>
    </section>

    <!-- ============ UTAU 声库制作（写 oto/alias） ============ -->
    <section class="bk-card" data-guide="banks-make">
      <div class="bk-title">
        <Icon name="mic" :size="13" /> {{ t('UTAU 声库制作') }}
        <span class="sp" />
        <button class="btn" @click="showStore = !showStore">
          {{ showStore ? t('收起') : t('打开制作工具') }}
        </button>
      </div>
      <p class="muted small">
        {{ t('把 wav 切片并写 alias（oto）。这是「做声库」，与选歌手无关，所以放在这里。') }}
      </p>
      <Transition name="fade">
        <UtauVoicebankStore v-if="showStore" @installed="showStore = false" />
      </Transition>
    </section>

    <!-- ============ DiffSinger 推理组件 ============ -->
    <section class="bk-card" data-guide="banks-ds">
      <div class="bk-title">
        <Icon name="gear" :size="13" /> {{ t('DiffSinger 推理组件') }}
        <span class="sp" />
        <button class="btn" :class="{ primary: !ds.enabled }" :disabled="busy"
                @click="run(() => ds.setEnabled(!ds.enabled))">
          {{ ds.enabled ? t('停用模块') : t('启用模块') }}
        </button>
      </div>
      <p class="muted small">{{ t('停用会保留已下载的组件；未启用时零占用。') }}</p>

      <Transition name="fade">
      <div v-if="ds.enabled" class="bk-grid">
        <div class="bk-st" :class="{ ok: ds.depsOk }">
          <b>{{ t('Python 组件') }}</b>
          <p v-if="ds.depsOk" class="muted small">
            {{ t('就绪：') }}{{ ds.depsMissing.length === 0 ? 'onnxruntime / pyyaml' : '' }}
          </p>
          <!-- 安装进度（主进程 diffsinger:runtimeProgress → store.runtimePct/runtimeText）：
               没有它，用户只能对着一个禁用的「安装」按钮干等 -->
          <div v-if="ds.runtimeInstalling" class="ds-prog">
            <div class="ds-prog-track"><i :style="{ width: Math.max(2, ds.runtimePct) + '%' }" /></div>
            <span class="muted small ds-prog-text">
              {{ ds.runtimeText || t('正在安装…') }} {{ Math.round(ds.runtimePct) }}%
            </span>
            <button class="btn" @click="ds.cancelRuntimeInstall()">{{ t('取消') }}</button>
          </div>
          <p v-else-if="!ds.depsOk" class="muted small">{{ ds.depsError || (t('缺失：') + ds.depsMissing.join(', ')) }}</p>
          <button v-if="!ds.depsOk && !ds.runtimeInstalling" class="btn" :disabled="busy"
                  @click="run(() => ds.installRuntime())">
            {{ t('安装') }}
          </button>
        </div>
        <div class="bk-st" :class="{ ok: ds.vocoderInstalled }">
          <b>{{ t('声码器') }}</b>
          <p class="muted small">
            {{ ds.vocoderInstalled ? t('已安装（NSF-HiFiGAN）') : t('未安装（约 55 MB，下载后本地推理）') }}
          </p>
        </div>
      </div>
      </Transition>
    </section>
  </div>
</template>

<style scoped>
.banks { height: 100%; overflow: auto; }
.bk-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
           border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.bk-head b { font-size: 14px; }
.seg { display: inline-flex; gap: 6px; }
.seg button { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
              border: 1px solid var(--border); border-radius: 9px; padding: 5px 11px;
              background: transparent; color: inherit; }
.seg button b { font-size: 12px; font-weight: 500; }
.seg button i { font-style: normal; font-size: 10.5px; opacity: .78; }
.seg button.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.bk-msg { margin: 8px 16px; color: var(--brand-text); }
.bk-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.bk-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.bk-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-bottom: 8px; }
.bk-title .sp { flex: 1; }
.bk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.bk-st { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.bk-st.ok { border-color: rgba(80,190,120,.5); }
.bk-st b { font-size: 12px; }
/* DS 组件安装进度条（runtimePct/runtimeText） */
.ds-prog { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ds-prog-track { flex: 1; min-width: 60px; height: 6px; border-radius: 3px;
                 background: var(--surface-muted); overflow: hidden; }
.ds-prog-track i { display: block; height: 100%; background: var(--brand);
                   transition: width .25s; }
.ds-prog-text { white-space: nowrap; }
.bk-list { list-style: none; margin: 0; padding: 0; }
.bk-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0;
              border-bottom: 1px solid var(--border); }
.bk-list li:last-child { border-bottom: none; }
.bk-list .nm { font-size: 12.5px; }
.bk-list .btn { margin-left: auto; }
.seg { display: inline-flex; gap: 4px; }
.seg button { font-size: 11px; padding: 1px 8px; border-radius: 9px; cursor: pointer;
              border: 1px solid var(--border); background: transparent; color: inherit; }
.seg button.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.bk-list .tag { font-size: 10px; padding: 1px 5px; border-radius: 4px;
                border: 1px solid var(--border); flex: none; }
.tag.e-utau { background: rgba(80,190,120,.18); }
.tag.e-diffsinger { background: rgba(64,140,255,.18); }
.bk-list .inuse { font-size: 10.5px; color: var(--brand-text); flex: none; }
</style>
