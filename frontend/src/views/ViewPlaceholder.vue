<script setup>
import Icon from '../components/Icon.vue';
import { VIEWS } from '../stores/app';

const props = defineProps({ viewId: { type: String, required: true } });
const v = VIEWS.find(x => x.id === props.viewId) || { label: props.viewId, ic: 'spark' };
const ICONS = { home: 'home', play: 'play2', lyrics: 'music', edit: 'edit', viz: 'viz', analyze: 'chart', score: 'score', transcribe: 'transcribe', convert: 'convert' };
</script>

<template>
  <div class="page">
    <div class="migrate-card card">
      <div class="mig-ic"><Icon :name="ICONS[v.id] || 'spark'" :size="30" /></div>
      <h2>{{ v.label }}视图</h2>
      <p>该功能正在逐步迁移到新的现代化界面中。核心能力（MIDI 解析、Web Audio 合成、播放调度）已完成模块化，此视图将在后续迭代接入。</p>
      <div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
        <button class="btn ghost sm" disabled><Icon name="spark" :size="14" /> 迁移计划中</button>
        <span class="tag">渐进式重构 · 保留离线能力</span>
      </div>
    </div>
  </div>
</template>
