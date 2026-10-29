<script setup>
// 第三方模型/音色/插件免责声明：FuFumidi 本体开源免费，资源由用户自行选择下载。
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';
</script>

<template>
  <div class="card license-disclaimer">
    <h4><Icon name="info" :size="14" /> {{ t('第三方资源免责声明') }}</h4>
    <p>{{ t('FuFumidi 本体开源免费。模型、音色库、插件等第三方资源由用户自行选择下载，其版权与许可归各自作者所有。') }}</p>
    <p>{{ t('本软件不授予任何第三方模型的商业使用权。下载或使用即表示你同意遵守对应资源的许可证及当地法律。') }}</p>
    <p>{{ t('第三方资源按“现状”提供，不附带任何担保；模型效果、兼容性与可用性由原作者决定。') }}</p>
  </div>
</template>

<style scoped>
.license-disclaimer { padding: var(--sp-3); border-color: color-mix(in srgb, var(--accent-sky) 18%, var(--hairline)); }
.license-disclaimer h4 { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2); }
.license-disclaimer p { margin: 0 0 6px; color: var(--text3); font-size: var(--fs-xs); line-height: 1.65; }
.license-disclaimer p:last-child { margin-bottom: 0; }
</style>