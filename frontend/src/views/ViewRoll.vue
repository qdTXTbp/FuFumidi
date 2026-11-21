<script setup>
/* ============================================================
   ViewRoll.vue —— 「卷帘」独立板块（音乐分组第四个页签）
   ============================================================
   和「可视化」里那张卡是同一个组件，差别只有 page 模式：
   这里它撑满整页，卡片里是 clamp 高度。
   单独成页的原因：卷帘要横向铺满整首曲子、纵向铺满音域，
   挤在仪表盘网格里只能看个大概。
   ============================================================ */
import RollPreview from '../components/viz/RollPreview.vue';
</script>

<template>
  <div class="page roll-page">
    <RollPreview page />
  </div>
</template>

<style scoped>
.roll-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
</style>
