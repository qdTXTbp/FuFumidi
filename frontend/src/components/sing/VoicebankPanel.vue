<!--
  声库面板 —— 从原「声库」独立页（ViewBanks.vue）并入「调教」页。

  并入原因：声库（做/装/管）与编辑器（选歌手、画音符、渲染）是同一条工作流的两半，
  分成两个顶栏入口会让用户在两个页面之间来回跳。现在它们同页、以页签切换。

  ★ 不透明底：本面板与 .sing 容器都用 --canvas / --surface 实心色。
    动态壁纸开启时 .app-main 是透明的（styles.css 的 .app-shell.wallpaper-on），
    如果这里也用 glass/半透明，密集文字会压在壁纸上看不清 —— 这正是改版前的实测问题。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Icon from '../Icon.vue';
import UtauVoicebankStore from '../utau/UtauVoicebankStore.vue';
import { t } from '../../core/i18n.js';
import { useDiffsingerStore } from '../../stores/diffsinger';
import { useSingerStore } from '../../stores/singer';

const ds = useDiffsingerStore();
const singerStore = useSingerStore();

onMounted(() => { void singerStore.loadBanks(); });

const busy = ref(false);
const msg = ref('');
const showStore = ref(false);

/** 声库列表只有**一个**来源（singer store 的 `banks`），不按引擎分区。 */
const filter = ref<'all' | 'utau' | 'diffsinger'>('all');
const allBanks = computed(() => singerStore.banks);
const shown = computed(() =>
  filter.value === 'all' ? allBanks.value : allBanks.value.filter(b => b.engine === filter.value));
/** 某个目录被哪些轨道用着（避免误删正在用的声库） */
const usedIn = (dir: string) => singerStore.bankInUse(dir);

async function refresh() { await singerStore.loadBanks(); }

async function run(fn: () => Promise<any>) {
  busy.value = true;
  msg.value = '';
  try { msg.value = (await fn()) || ''; }
  catch (e) { msg.value = String((e && (e as any).message) || e); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="vbp-page">
    <div class="vbp-head">
      <Icon name="box" :size="15" />
      <b>{{ t('声库管理') }}</b>
      <span class="muted small">{{ t('UTAU 与 DiffSinger 的声库都在这里；类型只作标签，不分区') }}</span>
      <span class="sp" />
      <button class="btn" :disabled="busy" @click="run(refresh)">
        <Icon name="refresh" :size="12" /> {{ t('刷新') }}
      </button>
    </div>

    <p v-if="msg" class="vbp-msg small">{{ msg }}</p>

    <!-- ============ 已装声库：一份混排列表 ============ -->
    <section class="vbp-card" data-guide="banks-installed">
      <div class="vbp-title">
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
      <ul v-else class="vbp-list">
        <li v-for="b in shown" :key="b.engine + b.dir">
          <span class="tag" :class="'e-' + b.engine">{{ b.engine === 'utau' ? 'UTAU' : 'DS' }}</span>
          <span class="nm">{{ b.name }}</span>
          <span class="dir muted small" :title="b.dir">{{ b.dir }}</span>
          <span v-if="usedIn(b.dir)" class="inuse">{{ t('使用中') }}</span>
          <button v-if="b.engine === 'diffsinger'" class="btn danger"
                  :disabled="busy || usedIn(b.dir)"
                  @click="run(() => ds.deleteVoicebank(b.dir))">{{ t('删除') }}</button>
          <span v-else class="muted small">{{ t('在 UTAU 声库管理器里删除') }}</span>
        </li>
      </ul>
    </section>

    <!-- ============ UTAU 声库制作（写 oto/alias） ============ -->
    <section class="vbp-card" data-guide="banks-make">
      <div class="vbp-title">
        <Icon name="mic" :size="13" /> {{ t('UTAU 声库制作') }}
        <span class="sp" />
        <button class="btn" @click="showStore = !showStore">
          {{ showStore ? t('收起') : t('打开制作工具') }}
        </button>
      </div>
      <p class="muted small">
        {{ t('把 wav 切片并写 alias（oto）。这是「做声库」，与选歌手无关，所以放在这里。') }}
      </p>
      <UtauVoicebankStore v-if="showStore" @installed="showStore = false" />
    </section>

    <!-- ============ DiffSinger 推理组件 ============ -->
    <section class="vbp-card" data-guide="banks-ds">
      <div class="vbp-title">
        <Icon name="gear" :size="13" /> {{ t('DiffSinger 推理组件') }}
        <span class="sp" />
        <button class="btn" :class="{ primary: !ds.enabled }" :disabled="busy"
                @click="run(() => ds.setEnabled(!ds.enabled))">
          {{ ds.enabled ? t('停用模块') : t('启用模块') }}
        </button>
      </div>
      <p class="muted small">{{ t('停用会保留已下载的组件；未启用时零占用。') }}</p>

      <div v-if="ds.enabled" class="vbp-grid">
        <div class="vbp-st" :class="{ ok: ds.depsOk }">
          <b>{{ t('Python 组件') }}</b>
          <p v-if="ds.depsOk" class="muted small">
            {{ t('就绪：') }}{{ ds.depsMissing.length === 0 ? 'onnxruntime / pyyaml' : '' }}
          </p>
          <p v-else class="muted small">{{ ds.depsError || (t('缺失：') + ds.depsMissing.join(', ')) }}</p>
          <button v-if="!ds.depsOk" class="btn" :disabled="busy" @click="run(() => ds.installRuntime())">
            {{ t('安装') }}
          </button>
        </div>
        <div class="vbp-st" :class="{ ok: ds.vocoderInstalled }">
          <b>{{ t('声码器') }}</b>
          <p class="muted small">
            {{ ds.vocoderInstalled ? t('已安装（NSF-HiFiGAN）') : t('未安装（约 55 MB，下载后本地推理）') }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ★ 实心底：壁纸开启时 .app-main 透明，这里必须自己铺不透明底，否则文字压在壁纸上 */
.vbp-page { height: 100%; overflow: auto; background: var(--canvas); padding: 12px 16px 18px; }
.vbp-head { display: flex; align-items: center; gap: 10px; padding-bottom: 10px;
            border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.vbp-head b { font-size: 14px; }
.vbp-msg { margin: 8px 0 0; color: var(--brand-text); }
.vbp-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
            margin-top: 12px; background: var(--surface); }
.vbp-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-bottom: 8px; }
.vbp-title .sp { flex: 1; }
.vbp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.vbp-st { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--canvas); }
.vbp-st.ok { border-color: rgba(80, 190, 120, .5); }
.vbp-st b { font-size: 12px; }
.vbp-list { list-style: none; margin: 0; padding: 0; }
.vbp-list li { display: flex; align-items: center; gap: 8px; padding: 5px 0;
               border-bottom: 1px solid var(--border); }
.vbp-list li:last-child { border-bottom: none; }
.vbp-list .nm { font-size: 12.5px; flex: none; }
.vbp-list .dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg { display: inline-flex; gap: 4px; }
.seg button { font-size: 11px; padding: 2px 9px; border-radius: 9px; cursor: pointer;
              border: 1px solid var(--border); background: var(--canvas); color: inherit; }
.seg button.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.vbp-list .tag { font-size: 10px; padding: 1px 5px; border-radius: 4px;
                 border: 1px solid var(--border); flex: none; }
.tag.e-utau { background: rgba(80, 190, 120, .18); }
.tag.e-diffsinger { background: rgba(64, 140, 255, .18); }
.vbp-list .inuse { font-size: 10.5px; color: var(--brand-text); flex: none; }
</style>
